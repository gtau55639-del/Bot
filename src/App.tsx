import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity, AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowRight, Bot, Check, CheckCircle2,
  CircleHelp, Clock3, CloudUpload, Code2, Command, Cpu, Download, FileArchive,
  FileCode2, FileText, Gauge, Github, HardDrive, Home, KeyRound, LayoutDashboard,
  LoaderCircle, LockKeyhole, Menu, MessageCircle, Play, Plus,
  RefreshCw, Rocket, Settings, ShieldCheck, Sparkles, Square, Terminal, Trash2,
  Upload, Wifi, X
} from "lucide-react";
import { isReservedEnvName, parseDotEnv } from "./dotenv";

type Analysis = {
  projectId: string; name: string; size: number; fileCount: number; files: string[];
  language: string; entryPoint: string | null; packageManager: string | null;
  dependencies: string[]; scripts: Record<string, string>; envKeys: string[];
  commands: string[]; features: { name: string; status: string; detail: string }[];
  warnings: string[]; compatible: boolean; extracted: boolean; installed: boolean;
  runtimeStatus: string; createdAt: string; envSet?: string[];
  autoRestart?: boolean; autoStart?: boolean;
};
type RunInfo = { pid: number | null; startedAt: string | null; uptimeSec: number | null; restarts: number; lastExit: { code: number | null; signal: string | null; at: string } | null; nextRestartAt: string | null };
type SystemInfo = { node: string; platform: string; serverUptimeSec: number; memoryMb: number; disk: { totalBytes: number; freeBytes: number } | null; bots: { running: number; max: number; total: number }; runnerEnabled: boolean };
type Session = { authRequired: boolean; runnerEnabled: boolean; runnerRequested: boolean; maxUploadMb?: number };
type Action = "install" | "start" | "stop" | "restart" | "backup" | "delete";
type Nav = "Overview" | "My Bots" | "Templates" | "Activity Logs" | "Settings";
const API = "/api";
const TOKEN_KEY = "botlaunch.token";
const SERVER_KEY = "botlaunch.server";
// window.Capacitor only exists inside the Android app (APK); in a browser this is false.
const isNative = () => !!(window as any).Capacitor?.isNativePlatform?.();
const store = () => (isNative() ? localStorage : sessionStorage); // APK keeps you logged in
const getToken = () => { try { return store().getItem(TOKEN_KEY) || ""; } catch { return ""; } };
const setToken = (t: string) => { try { t ? store().setItem(TOKEN_KEY, t) : store().removeItem(TOKEN_KEY); } catch { /* storage blocked */ } };
const getServer = () => { try { return isNative() ? localStorage.getItem(SERVER_KEY) || "" : ""; } catch { return ""; } };
const setServer = (v: string) => { try { localStorage.setItem(SERVER_KEY, v); } catch { /* storage blocked */ } };
const apiBase = () => `${getServer()}${API}`;
function normalizeServer(raw: string): string | null {
  let v = raw.trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\//i.test(v)) v = `https://${v}`;
  try { const u = new URL(v); return u.protocol === "https:" ? u.origin : null; } catch { return null; }
}
async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const r = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (r.status === 401) window.dispatchEvent(new Event("botlaunch-unauthorized"));
  return r;
}
// Real upload progress (fetch cannot report it). Resolves with the parsed JSON body.
function uploadForm(path: string, form: FormData, onProgress: (pct: number) => void): Promise<{ ok: boolean; data: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase()}${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let data: any = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
      if (xhr.status === 401) window.dispatchEvent(new Event("botlaunch-unauthorized"));
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, data });
    };
    xhr.onerror = () => reject(new Error("Koneksi terputus saat mengunggah. Periksa server dan internet."));
    xhr.send(form);
  });
}
const fmtUptime = (sec: number | null) => {
  if (sec === null) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}h ${h}j`; if (h) return `${h}j ${m}m`; if (m) return `${m}m ${sec % 60}d`; return `${sec}d`;
};
const fmtBytes = (b: number) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`;
const prettySize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function App() {
  const [nav, setNav] = useState<Nav>("Overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [projects, setProjects] = useState<Analysis[]>([]);
  const [selected, setSelected] = useState<Analysis | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState("");
  const [logs, setLogs] = useState<{time:string; level:string; message:string}[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<Session>({ authRequired: false, runnerEnabled: false, runnerRequested: false, maxUploadMb: 50 });
  const [needLogin, setNeedLogin] = useState(() => isNative() && !getServer());
  const [apiUp, setApiUp] = useState<"checking" | "online" | "offline">("checking");

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3600); };
  async function loadProjects() {
    try {
      const r = await api(`/projects`);
      if (r.ok) { const data = await r.json(); setProjects(data.projects || []); }
    } catch { /* API status is shown in the header */ }
  }
  async function loadLogs(id?: string) {
    try {
      const r = await api(`/logs${id ? `?projectId=${encodeURIComponent(id)}` : ""}`);
      if (r.ok) { const data = await r.json(); setLogs(data.logs || []); }
    } catch {}
  }
  async function checkApi() {
    if (isNative() && !getServer()) return null; // APK: waiting for the server address
    try {
      const r = await fetch(`${apiBase()}/session`);
      if (!r.ok) throw new Error("bad status");
      const s: Session = await r.json();
      setSession(s); setApiUp("online");
      if (s.authRequired && !getToken()) setNeedLogin(true);
      return s;
    } catch { setApiUp("offline"); return null; }
  }
  useEffect(() => {
    const onUnauthorized = () => { setToken(""); setNeedLogin(true); };
    window.addEventListener("botlaunch-unauthorized", onUnauthorized);
    checkApi().then(s => { if (s && (!s.authRequired || getToken())) { loadProjects(); loadLogs(); } });
    const t = setInterval(() => { checkApi().then(s => { if (s && !document.hidden && (!s.authRequired || getToken())) loadProjects(); }); }, 4000);
    return () => { clearInterval(t); window.removeEventListener("botlaunch-unauthorized", onUnauthorized); };
  }, []);
  async function login(token: string, server: string): Promise<string | null> {
    if (isNative()) {
      const v = normalizeServer(server);
      if (!v) return "Alamat server tidak valid. Gunakan alamat https, contoh: https://botlaunch.onrender.com";
      setServer(v);
    }
    setToken(token.trim());
    try {
      const sr = await fetch(`${apiBase()}/session`);
      if (!sr.ok) throw new Error("bad status");
      const sess: Session = await sr.json();
      setSession(sess); setApiUp("online");
      if (!sess.authRequired) { setNeedLogin(false); loadProjects(); loadLogs(); return null; }
    } catch { setApiUp("offline"); return "Tidak dapat terhubung ke server. Periksa alamat dan koneksi internet."; }
    const r = await api("/projects");
    if (r.ok) { setNeedLogin(false); const d = await r.json(); setProjects(d.projects || []); loadLogs(); return null; }
    setToken("");
    const d = await r.json().catch(() => ({}));
    return d.error || "Token tidak valid.";
  }
  function logout() { setToken(""); setProjects([]); setSelected(null); setAnalysis(null); setNeedLogin(true); }

  const onlineCount = projects.filter(p => p.runtimeStatus === "online").length;
  const picked = selected || analysis;
  const current = picked ? projects.find(x => x.projectId === picked.projectId) ?? picked : null;
  const navItems: { label: Nav; icon: typeof Home; hint?: string }[] = [
    { label: "Overview", icon: LayoutDashboard },
    { label: "My Bots", icon: Bot },
    { label: "Templates", icon: FileArchive },
    { label: "Activity Logs", icon: Activity },
    { label: "Settings", icon: Settings }
  ];

  async function analyzeUpload() {
    if (!file) return;
    setBusy("analyzing"); setProgress(1);
    try {
      const form = new FormData(); form.append("template", file);
      // Real bytes-sent percentage; once everything is sent the server is analysing (indeterminate bar).
      const { ok, data } = await uploadForm(`/analyze`, form, pct => setProgress(pct >= 100 ? -1 : Math.max(1, pct)));
      if (!ok) throw new Error(data.error || "Analisis gagal.");
      setProgress(100); setAnalysis(data.project); setSelected(null);
      await loadProjects(); notify("Analisis template selesai.");
    } catch (e) { notify(e instanceof Error ? e.message : "Tidak dapat menganalisis ZIP."); }
    finally { setBusy(""); window.setTimeout(() => setProgress(0), 900); }
  }
  async function setupProject(p: Analysis) {
    setBusy("setup"); setProgress(-1);
    try {
      const r = await api(`/projects/${p.projectId}/setup`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Setup gagal.");
      setProgress(100); setAnalysis(data.project); setSelected(data.project); await loadProjects();
      await loadLogs(p.projectId); notify("Workspace disiapkan. Lanjut: Install dependencies di halaman My Bots.");
    } catch(e) { notify(e instanceof Error ? e.message : "Setup gagal."); }
    finally { setBusy(""); window.setTimeout(() => setProgress(0), 900); }
  }
  async function downloadBackup(url: string) {
    const r = await api(url.replace(/^\/api/, ""));
    if (!r.ok) throw new Error("Backup gagal diunduh.");
    const blob = await r.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href; a.download = decodeURIComponent(url.split("/").pop() || "backup.zip"); a.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
  async function projectAction(p: Analysis, action: Action) {
    if (action === "delete" && !window.confirm(`Hapus proyek "${p.name}" beserta workspace-nya?`)) return;
    setBusy(action);
    try {
      const r = await api(`/projects/${p.projectId}/${action}`, { method: "POST" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Aksi gagal.");
      if (action === "delete") { setSelected(null); setAnalysis(null); }
      if (action === "backup" && data.downloadUrl) await downloadBackup(data.downloadUrl);
      notify(data.message || "Aksi selesai.");
    } catch(e) { notify(e instanceof Error ? e.message : "Aksi gagal."); }
    finally { setBusy(""); await loadProjects(); await loadLogs(p.projectId); }
  }
  function openProject(p: Analysis) { setSelected(p); setAnalysis(p); setNav("My Bots"); loadLogs(p.projectId); }
  function resetUpload() { setFile(null); setAnalysis(null); setSelected(null); if(inputRef.current) inputRef.current.value = ""; }

  if (needLogin) return <LoginScreen onLogin={login} offline={apiUp === "offline"}/>;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><Rocket size={20}/></div><div><strong>BOTLAUNCH<span> AI</span></strong><small>BOT MANAGEMENT</small></div><button className="icon-btn close-nav" onClick={()=>setMobileNav(false)}><X size={18}/></button></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>{navItems.map(item => <button key={item.label} className={`nav-item ${nav===item.label?"active":""}`} onClick={()=>{setNav(item.label);setMobileNav(false);if(item.label==="Activity Logs")loadLogs();}}><item.icon size={18}/><span>{item.label}</span>{item.label==="My Bots"&&projects.length>0&&<em>{projects.length}</em>}</button>)}</nav>
      <div className="sidebar-spacer"/>
      <div className="plan-card"><div className="plan-icon"><Cpu size={16}/></div><b>Runner {session.runnerEnabled?"aktif":"nonaktif"}</b><p>{session.runnerEnabled?`${onlineCount} bot online. Batas bot aktif diatur MAX_RUNNING_BOTS di server.`:"Atur ENABLE_RUNNER=true dan ADMIN_TOKEN di server agar bot bisa dijalankan."}</p><button onClick={()=>{setNav("Settings");setMobileNav(false);}}>Status server <ArrowRight size={14}/></button></div>
      {session.authRequired&&<button className="user-row logout-row" onClick={logout}><LockKeyhole size={16}/><div><b>Keluar</b><small>Hapus token dari perangkat ini</small></div></button>}
    </aside>
    {mobileNav && <button className="scrim" onClick={()=>setMobileNav(false)} aria-label="Close navigation"/>}
    <main className="main-area">
      <header className="topbar"><button className="icon-btn menu-btn" onClick={()=>setMobileNav(true)}><Menu size={20}/></button><div className="breadcrumb">Workspace <span>/</span> <b>{nav}</b></div><div className="top-actions"><div className={`service-pill ${apiUp}`}><span className="pulse-dot"/> API status <b>{apiUp === "online" ? "Online" : apiUp === "offline" ? "Offline" : "Checking"}</b></div>{session.authRequired && <button className="icon-btn" title="Keluar" onClick={logout}><LockKeyhole size={18}/></button>}<button className="icon-btn" title="Help" onClick={()=>notify("Alur: Upload ZIP → Analisis → Prepare workspace → Install dependencies → Isi env → Start.")}><CircleHelp size={18}/></button></div></header>
      <div className="page-content">
        {nav==="Overview" && <Overview projects={projects} onlineCount={onlineCount} runnerEnabled={session.runnerEnabled} onUpload={()=>{setNav("Templates");setTimeout(()=>inputRef.current?.click(),80)}} onOpen={openProject} onNavigate={setNav} onAction={projectAction}/>}
        {nav==="Templates" && <section className="page-section">
          <PageTitle eyebrow="PROJECT SETUP" title="Upload a template" subtitle="Start with a ZIP template. BOTLAUNCH will inspect the project before any code is run."/>
          <div className="upload-layout">
            <div className="panel upload-panel">
              <div className="panel-heading"><div><h3>Template ZIP</h3><p>Choose the bot project archive you want to inspect.</p></div><span className="soft-tag">STEP 01</span></div>
              {!file ? <button className="dropzone" onClick={()=>inputRef.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files?.[0];if(f)setFile(f);}}>
                <div className="upload-icon"><CloudUpload size={26}/></div><b>Drop your ZIP file here</b><span>or click to browse files</span><small>ZIP archive · Max {session.maxUploadMb ?? 50} MB</small>
              </button> : <div className="file-picked"><div className="file-icon"><FileArchive size={22}/></div><div className="file-meta"><b>{file.name}</b><span>{prettySize(file.size)} · ZIP archive</span></div><button className="icon-btn" onClick={resetUpload} aria-label="Remove file"><Trash2 size={17}/></button></div>}
              <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={e=>setFile(e.target.files?.[0]||null)}/>
              {progress!==0&&<div className="progress-wrap"><div className="progress-label"><span>{busy==="analyzing"?(progress<0||progress>=100?"Menganalisis arsip…":"Mengunggah ZIP…"):"Menyiapkan workspace…"}</span>{progress>0&&<b>{progress}%</b>}</div><div className="progress-track"><i className={progress<0?"indeterminate":""} style={progress<0?undefined:{width:`${progress}%`}}/></div></div>}
              <div className="upload-foot"><span><ShieldCheck size={15}/> ZIP inspected before execution</span><button className="btn btn-primary" disabled={!file||!!busy} onClick={analyzeUpload}>{busy==="analyzing"?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>} Analyze template <ArrowRight size={15}/></button></div>
              <div className="notice"><LockKeyhole size={17}/><p><b>Security first</b><br/>Uploaded files are inspected first. Code only runs when you press Start, and only if the runner is enabled by the server admin.</p></div>
            </div>
            <div className="panel checklist-panel"><div className="panel-heading"><div><h3>What we check</h3><p>Preflight compatibility scan</p></div><ShieldCheck size={20} className="green-icon"/></div>
              {["Archive integrity & file paths","Node.js / TypeScript indicators","package.json & scripts","Likely entry point","Environment variable names","Potential bot features"].map((x,i)=><div className="check-row" key={x}><div className="check-number">{String(i+1).padStart(2,"0")}</div><span>{x}</span><CheckCircle2 size={16}/></div>)}
              <div className="supported"><b>Supported first</b><div><span className="tech-dot node"/> Node.js</div><div><span className="tech-dot ts"/> TypeScript (detected)</div><small>Python runner is not available yet.</small></div>
            </div>
          </div>
          {analysis && <AnalysisCard project={analysis} onSetup={()=>setupProject(analysis)} onReset={resetUpload} busy={!!busy}/>}
        </section>}
        {nav==="My Bots" && <section className="page-section"><PageTitle eyebrow="YOUR PROJECTS" title="My bots" subtitle="Inspect projects and manage the local deployment lifecycle." action={<button className="btn btn-primary" onClick={()=>setNav("Templates")}><Plus size={16}/> New template</button>}/>
          {current && <ProjectDetail project={current} runnerEnabled={session.runnerEnabled} onAction={projectAction} busy={!!busy} onSetup={()=>setupProject(current)} onLogs={()=>{setNav("Activity Logs");loadLogs(current.projectId)}} reload={loadProjects}/>}
          <ProjectTable projects={projects} onOpen={openProject} onAction={projectAction} busy={!!busy}/>
        </section>}
        {nav==="Activity Logs" && <section className="page-section"><PageTitle eyebrow="OBSERVABILITY" title="Activity logs" subtitle="Recent server events and project actions." action={<button className="btn btn-secondary" onClick={()=>loadLogs(current?.projectId)}><RefreshCw size={15}/> Refresh</button>}/><div className="panel logs-panel"><div className="table-head"><span>EVENT</span><span>LEVEL</span><span>TIME</span></div>{logs.length===0?<EmptyState icon={Terminal} title="No activity yet" text="Upload a ZIP or perform a project action to see server logs here."/>:logs.slice().reverse().map((l,i)=><div className="log-row" key={i}><div><span className={`log-dot ${l.level}`}/><span>{l.message}</span></div><span className={`level-tag ${l.level}`}>{l.level}</span><time>{l.time}</time></div>)}</div></section>}
        {nav==="Settings" && <section className="page-section"><PageTitle eyebrow="PREFERENCES" title="Settings" subtitle="Manage local settings and deploy this web app using the included GitHub-ready files."/><div className="panel settings-card deploy-card"><div className="settings-icon"><Rocket/></div><h3>Deploy this application</h3><p>Push this project to GitHub, then create a Web Service from the repository on Render. The included render.yaml configures the app and persistent JSON storage.</p><div className="deploy-links"><a className="btn btn-primary" href="https://github.com/new" target="_blank" rel="noreferrer"><Github size={16}/> Create GitHub repo</a><a className="btn btn-secondary" href="https://dashboard.render.com/" target="_blank" rel="noreferrer">Open Render <ArrowRight size={15}/></a></div><small>After pushing the repository, choose New → Blueprint on Render. Keep the persistent disk enabled.</small></div><SystemPanel/><div className="settings-grid"><div className="panel settings-card"><div className="settings-icon"><ShieldCheck/></div><h3>Security & isolation</h3><p>ZIP inspection, path validation, token login, and a sanitized child-process environment are enabled. Bots run as normal child processes (not a sandbox): only upload templates you trust, and prefer a dedicated container/VM.</p><span className={`status-chip ${session.runnerEnabled ? "success" : "warning"}`}>{session.runnerEnabled ? "Runner enabled" : session.runnerRequested ? "Set ADMIN_TOKEN" : "Runner disabled"}</span></div><div className="panel settings-card"><div className="settings-icon"><DatabaseIcon/></div><h3>Persistent storage</h3><p>This version uses JSON files on persistent local disk. Attach persistent storage on your host so projects survive redeploys.</p><span className="status-chip success">JSON storage</span></div><div className="panel settings-card"><div className="settings-icon"><MessageCircle/></div><h3>WhatsApp provider</h3><p>WhatsApp sessions and pairing are handled by the bot template itself (for example a QR code printed in the bot log). BOTLAUNCH shows the bot log so you can scan it.</p><span className="status-chip neutral">Not configured</span></div><div className="panel settings-card"><div className="settings-icon"><KeyRound/></div><h3>AI analysis</h3><p>Static file analysis is enabled. AI provider integration can be added without exposing project secrets.</p><span className="status-chip neutral">Static analysis</span></div></div></section>}
      </div>
      <footer className="footer"><span>BOTLAUNCH AI <span className="muted">· v0.3.0</span></span><span><span className="pulse-dot"/> Runner: {session.runnerEnabled ? "enabled" : "disabled"}</span></footer>
    </main>
    {toast && <div className="toast"><CheckCircle2 size={18}/>{toast}<button onClick={()=>setToast("")}><X size={15}/></button></div>}
  </div>;
}

function Overview({projects,onlineCount,runnerEnabled,onUpload,onOpen,onNavigate,onAction}:{projects:Analysis[];onlineCount:number;runnerEnabled:boolean;onUpload:()=>void;onOpen:(p:Analysis)=>void;onNavigate:(n:Nav)=>void;onAction:(p:Analysis,a:Action)=>void}) {
  const recent = projects.slice(0,4);
  return <section className="page-section">
    <div className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-line"/> BOT WORKSPACE</div><h1>Deploy your bots.<br/><span>Keep everything</span> in control.</h1><p>Inspect templates, prepare workspaces, and manage your bot projects from one place.</p><div className="welcome-actions"><button className="btn btn-primary btn-lg" onClick={onUpload}><CloudUpload size={17}/> Upload template <ArrowRight size={16}/></button><button className="btn btn-secondary btn-lg" onClick={()=>onNavigate("Templates")}><FileText size={16}/> View workflow</button></div></div><div className="hero-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="hero-core"><Bot size={46}/><span className="core-spark"><Sparkles size={17}/></span></div><div className="float-card float-top"><span className="mini-status green"/><div><b>{projects.length} template</b><small>sudah dianalisis</small></div><CheckCircle2 size={17}/></div><div className="float-card float-bottom"><span className={`mini-status ${onlineCount?"green":""}`}/><div><b>{onlineCount} bot online</b><small>Runner {runnerEnabled?"aktif":"nonaktif"}</small></div></div></div></div>
    <div className="stats-grid"><StatCard icon={Bot} label="Total projects" value={String(projects.length).padStart(2,"0")} detail="Uploaded workspaces" tone="purple"/><StatCard icon={Wifi} label="Bots online" value={String(onlineCount).padStart(2,"0")} detail="Proses yang benar-benar berjalan" tone="green"/><StatCard icon={Download} label="Dependencies ready" value={String(projects.filter(p=>p.installed).length).padStart(2,"0")} detail="Sudah di-install" tone="blue"/><StatCard icon={AlertTriangle} label="Needs attention" value={String(projects.filter(p=>p.runtimeStatus==="error").length).padStart(2,"0")} detail="Bot dengan status error" tone="orange"/></div>
    <div className="section-heading"><div><h2>Recent projects</h2><p>Your latest bot workspaces</p></div><button className="text-link" onClick={()=>onNavigate("My Bots")}>View all projects <ArrowRight size={15}/></button></div>
    {recent.length===0?<div className="panel empty-project"><div className="empty-illustration"><FileCode2 size={27}/><Plus size={15}/></div><h3>Your first bot starts here</h3><p>Upload a ZIP template to inspect its structure and prepare a workspace.</p><button className="btn btn-primary" onClick={onUpload}><Upload size={16}/> Upload your first template</button></div>:<ProjectTable projects={recent} onOpen={onOpen} onAction={onAction} busy={false}/>}
    <div className="bottom-cards"><div className="panel bottom-card"><div className="bottom-icon purple-bg"><Sparkles size={18}/></div><div><b>Smart template analysis</b><p>Find entry points, dependencies, and likely features before setup.</p></div><ArrowRight size={17}/></div><div className="panel bottom-card"><div className="bottom-icon green-bg"><ShieldCheck size={18}/></div><div><b>Security-first workflow</b><p>Inspect archives before any untrusted project code is executed.</p></div><ArrowRight size={17}/></div></div>
  </section>;
}
function StatCard({icon:Icon,label,value,detail,tone}:{icon:any;label:string;value:string;detail:string;tone:string}){return <div className="panel stat-card"><div className={`stat-icon ${tone}`}><Icon size={18}/></div><span>{label}</span><div className="stat-value">{value}</div><small>{detail}</small></div>}
function PageTitle({eyebrow,title,subtitle,action}:{eyebrow:string;title:string;subtitle:string;action?:ReactNode}){return <div className="page-title"><div><div className="eyebrow"><span className="eyebrow-line"/>{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>}
function ProjectTable({projects,onOpen,onAction,busy}:{projects:Analysis[];onOpen:(p:Analysis)=>void;onAction:(p:Analysis,a:Action)=>void;busy:boolean}){
  return <div className="panel projects-panel"><div className="table-head project-head"><span>PROJECT</span><span>LANGUAGE</span><span>STATUS</span><span>LAST UPDATED</span><span>ACTIONS</span></div>{projects.length===0?<EmptyState icon={Bot} title="No projects yet" text="Upload a ZIP template to create your first project."/>:projects.map(p=><div className="project-row" key={p.projectId}><button className="project-name" onClick={()=>onOpen(p)}><div className="project-file"><FileCode2 size={19}/></div><span><b>{p.name}</b><small>{p.entryPoint||"Entry point not found"}</small></span></button><div><span className="language-pill">{p.language}</span></div><div><StatusBadge status={p.runtimeStatus}/></div><span className="date-text">{new Date(p.createdAt).toLocaleDateString("id-ID",{day:"2-digit",month:"short",year:"numeric"})}</span><div className="row-actions"><button title="Open project" className="icon-btn" onClick={()=>onOpen(p)}><ArrowRight size={16}/></button><button title="Backup project" className="icon-btn" disabled={busy} onClick={()=>onAction(p,"backup")}><ArrowDownToLine size={16}/></button></div></div>)}</div>
}
function StatusBadge({status}:{status:string}){const map:Record<string,[string,string]>={online:["Online","online"],stopped:["Stopped","stopped"],ready:["Ready","ready"],analyzed:["Analyzed","ready"],installing:["Installing","ready"],error:["Error","error"],restarting:["Restarting","ready"],"not-connected":["Not connected","stopped"]};const [label,cls]=map[status]||["Not deployed","stopped"];return <span className={`status-badge ${cls}`}><i/>{label}</span>}
function AnalysisCard({project,onSetup,onReset,busy}:{project:Analysis;onSetup:()=>void;onReset:()=>void;busy:boolean}){return <div className="panel analysis-card"><div className="analysis-top"><div className="analysis-symbol"><FileArchive size={23}/></div><div><span className="soft-tag">ANALYSIS REPORT</span><h3>{project.name}</h3><p>{project.fileCount} files detected · {prettySize(project.size)}</p></div><span className={`status-chip ${project.compatible?"success":"warning"}`}>{project.compatible?"Basic checks passed":"Review required"}</span></div><div className="analysis-grid"><InfoItem label="Language" value={project.language}/><InfoItem label="Entry point" value={project.entryPoint||"Not detected"}/><InfoItem label="Package manager" value={project.packageManager||"Not detected"}/><InfoItem label="Dependencies" value={String(project.dependencies.length)}/></div>{project.warnings.length>0&&<div className="warning-box"><ShieldCheck size={17}/><div><b>Review before setup</b>{project.warnings.map((w,i)=><p key={i}>{w}</p>)}</div></div>}{project.features.length>0&&<div className="feature-chips">{project.features.map(f=><span key={f.name}>{f.name}</span>)}</div>}<div className="analysis-actions"><button className="btn btn-secondary" onClick={onReset}>Remove template</button><button className="btn btn-primary" disabled={!project.compatible||busy} onClick={onSetup}><Rocket size={16}/>{busy?"Preparing…":"Prepare workspace"} <ArrowRight size={15}/></button></div></div>}
function InfoItem({label,value}:{label:string;value:string}){return <div className="info-item"><span>{label}</span><b>{value}</b></div>}
function ProjectDetail({project,runnerEnabled,onAction,busy,onSetup,onLogs,reload}:{project:Analysis;runnerEnabled:boolean;onAction:(p:Analysis,a:Action)=>void;busy:boolean;onSetup:()=>void;onLogs:()=>void;reload:()=>Promise<void>}){
  const online=project.runtimeStatus==="online";
  const installing=project.runtimeStatus==="installing";
  const restarting=project.runtimeStatus==="restarting";
  const active=online||installing||restarting;
  return <div className="panel detail-panel"><div className="detail-top"><div className="project-file large"><Bot size={23}/></div><div className="detail-name"><h2>{project.name}</h2><p>{project.language} · {project.fileCount} files · Created {new Date(project.createdAt).toLocaleString("id-ID")}</p></div><StatusBadge status={project.runtimeStatus}/></div>
    <div className="detail-metrics"><InfoItem label="Entry point" value={project.entryPoint||"Not detected"}/><InfoItem label="Dependencies" value={project.installed?"Installed":"Not installed"}/><InfoItem label="Env variables set" value={`${project.envSet?.length||0} / ${project.envKeys.length} detected`}/></div>
    <div className="detail-actions">{project.extracted?<>
      <button className="btn btn-secondary" disabled={busy||active||!runnerEnabled} onClick={()=>onAction(project,"install")}><ArrowDownToLine size={15}/> Install dependencies</button>
      <button className="btn btn-primary" disabled={busy||online||installing||!runnerEnabled} onClick={()=>onAction(project,"start")}><Play size={15}/> Start bot</button>
      <button className="btn btn-secondary" disabled={busy||!active||!runnerEnabled} onClick={()=>onAction(project,"stop")}><Square size={15}/> Stop</button>
      <button className="btn btn-secondary" disabled={busy||installing||!runnerEnabled} onClick={()=>onAction(project,"restart")}><RefreshCw size={15}/> Restart</button></>:<button className="btn btn-primary" disabled={busy||!project.compatible} onClick={onSetup}><Rocket size={15}/> Prepare workspace</button>}
      <button className="btn btn-secondary" disabled={busy||!project.extracted} onClick={()=>onAction(project,"backup")}><ArrowDownToLine size={15}/> Backup</button>
      <button className="btn btn-secondary" onClick={onLogs}><Terminal size={15}/> Server events</button>
      <button className="btn btn-secondary" disabled={busy||active} onClick={()=>onAction(project,"delete")}><Trash2 size={15}/> Delete</button></div>
    <div className="runtime-note"><ShieldCheck size={16}/><span>{runnerEnabled?"Runner aktif. Urutan: Prepare workspace → Install dependencies → isi environment variables → Start. Install berjalan dengan --ignore-scripts.":"Runner nonaktif di server ini. Atur ENABLE_RUNNER=true dan ADMIN_TOKEN (min. 12 karakter) lalu restart server untuk menjalankan bot."}</span></div>
    {project.extracted&&runnerEnabled&&<><AutoPanel project={project} onChanged={reload}/><EnvPanel project={project}/><RunLog project={project}/></>}
  </div>}
function EnvPanel({project}:{project:Analysis}){
  const [set,setSet]=useState<string[]>([]);
  const [values,setValues]=useState<Record<string,string>>({});
  const [removed,setRemoved]=useState<string[]>([]);
  const [custom,setCustom]=useState<string[]>([]);
  const [newKey,setNewKey]=useState("");
  const [msg,setMsg]=useState("");
  const [importOpen,setImportOpen]=useState(false);
  const [importText,setImportText]=useState("");
  useEffect(()=>{ setValues({}); setRemoved([]); setCustom([]); setMsg(""); setImportOpen(false); setImportText(""); api(`/projects/${project.projectId}/env`).then(r=>r.json()).then(d=>setSet(d.set||[])).catch(()=>{}); },[project.projectId]);
  const keys=[...new Set([...project.envKeys,...set,...custom])].filter(k=>!removed.includes(k));
  async function save(){
    const payload:Record<string,string>={}; for(const [k,v] of Object.entries(values) as [string,string][]) if(v!=="") payload[k]=v;
    const r=await api(`/projects/${project.projectId}/env`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({set:payload,remove:removed.filter(k=>set.includes(k))})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){setMsg(d.error||"Gagal menyimpan.");return;}
    setSet(d.set||[]); setValues({}); setRemoved([]); setMsg(d.message||"Tersimpan.");
  }
  function applyImport(){
    const parsed=parseDotEnv(importText);
    const all=Object.entries(parsed);
    const usable=all.filter(([k,v])=>v!==""&&!isReservedEnvName(k));
    if(usable.length===0){setMsg(all.length?"Semua baris kosong atau memakai nama yang dicadangkan sistem.":"Tidak ada baris KEY=VALUE yang terbaca.");return;}
    const known=new Set([...project.envKeys,...set,...custom]);
    setValues(v=>({...v,...Object.fromEntries(usable)}));
    setCustom(c=>[...c,...usable.map(([k])=>k).filter(k=>!known.has(k))]);
    setRemoved(r=>r.filter(k=>!(k in parsed)));
    setImportText(""); setImportOpen(false);
    setMsg(`${usable.length} variabel dibaca${all.length>usable.length?` (${all.length-usable.length} dilewati: kosong/dicadangkan)`:""}. Tekan Simpan untuk menyimpannya.`);
  }
  function addKey(){ const k=newKey.trim(); if(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)){setCustom(c=>[...c,k]);setRemoved(r=>r.filter(x=>x!==k));setNewKey("");} else setMsg("Nama variabel hanya huruf, angka, dan underscore."); }
  return <div className="sub-panel"><h4><KeyRound size={15}/> Environment variables</h4><p className="sub-hint">Nilai disimpan di server dan tidak pernah dikirim kembali ke browser. Restart bot setelah mengubah.</p>
    {keys.length===0&&<p className="sub-hint">Belum ada variabel terdeteksi. Tambahkan manual di bawah.</p>}
    {keys.map(k=><div className="env-row" key={k}><label htmlFor={`env-${k}`}>{k}</label><input id={`env-${k}`} type="password" autoComplete="off" placeholder={set.includes(k)?"•••• tersimpan (kosongkan untuk tidak mengubah)":"belum diisi"} value={values[k]||""} onChange={e=>setValues(v=>({...v,[k]:e.target.value}))}/>{set.includes(k)&&<button className="icon-btn" title="Hapus" onClick={()=>setRemoved(r=>[...r,k])}><X size={15}/></button>}</div>)}
    <div className="env-import"><button className="btn btn-secondary" onClick={()=>setImportOpen(o=>!o)}><FileText size={14}/> Impor dari .env</button>
      {importOpen&&<><textarea autoComplete="off" spellCheck={false} placeholder={"BOT_TOKEN=isi_token\nOWNER_NUMBER=62812xxxx"} value={importText} onChange={e=>setImportText(e.target.value)}/><div className="env-row"><button className="btn btn-primary" disabled={!importText.trim()} onClick={applyImport}><Check size={14}/> Terapkan ke form</button><span className="sub-hint">Isi hanya dipakai di browser sampai Anda menekan Simpan.</span></div></>}</div>
    <div className="env-row"><input placeholder="NAMA_VARIABEL_BARU" value={newKey} onChange={e=>setNewKey(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addKey();}}/><button className="btn btn-secondary" onClick={addKey}><Plus size={14}/> Tambah</button><button className="btn btn-primary" onClick={save}><Check size={14}/> Simpan</button></div>
    {msg&&<p className="sub-hint">{msg}</p>}</div>}
function AutoPanel({project,onChanged}:{project:Analysis;onChanged:()=>Promise<void>}){
  const [saving,setSaving]=useState(false); const [msg,setMsg]=useState("");
  async function toggle(key:"autoRestart"|"autoStart",value:boolean){
    setSaving(true); setMsg("");
    try{
      const r=await api(`/projects/${project.projectId}/settings`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({[key]:value})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(d.error||"Gagal menyimpan.");
      await onChanged();
    }catch(e){ setMsg(e instanceof Error?e.message:"Gagal menyimpan."); }
    finally{ setSaving(false); }
  }
  return <div className="sub-panel"><h4><RefreshCw size={15}/> Otomatisasi</h4>
    <label className="switch-row"><input type="checkbox" role="switch" checked={!!project.autoRestart} disabled={saving} onChange={e=>toggle("autoRestart",e.target.checked)}/><span><b>Auto-restart saat berhenti sendiri</b><small>Bot dijalankan ulang dengan jeda bertahap (2 → 4 → 8 detik, dst.). Berhenti mencoba setelah 5 kegagalan beruntun. Tombol Stop tidak memicu restart.</small></span></label>
    <label className="switch-row"><input type="checkbox" role="switch" checked={!!project.autoStart} disabled={saving} onChange={e=>toggle("autoStart",e.target.checked)}/><span><b>Jalankan otomatis saat server menyala</b><small>Setelah server restart atau redeploy, bot ini dijalankan lagi tanpa menekan Start.</small></span></label>
    {msg&&<p className="sub-hint">{msg}</p>}</div>}
function RunLog({project}:{project:Analysis}){
  const [lines,setLines]=useState<string[]>([]);
  const [info,setInfo]=useState<RunInfo|null>(null);
  const ref=useRef<HTMLPreElement>(null);
  useEffect(()=>{ let alive=true; setLines([]); setInfo(null);
    const load=async()=>{ try{const r=await api(`/projects/${project.projectId}/runlog`); if(r.ok){const d=await r.json(); if(alive){setLines(d.lines||[]);setInfo(d.info||null);}}}catch{} };
    load(); const t=setInterval(load,2000); return()=>{alive=false;clearInterval(t);};
  },[project.projectId]);
  useEffect(()=>{ const el=ref.current; if(el) el.scrollTop=el.scrollHeight; },[lines]);
  async function clear(){ try{ const r=await api(`/projects/${project.projectId}/runlog`,{method:"DELETE"}); if(r.ok) setLines([]); }catch{} }
  function download(){
    const blob=new Blob([lines.join("\n")+"\n"],{type:"text/plain"});
    const href=URL.createObjectURL(blob); const a=document.createElement("a");
    a.href=href; a.download=`${project.name}-console.txt`; a.click();
    window.setTimeout(()=>URL.revokeObjectURL(href),10_000);
  }
  const running=info?.uptimeSec!=null;
  return <div className="sub-panel"><h4><Terminal size={15}/> Bot console</h4>
    {info&&<div className="runtime-stats"><InfoItem label="Uptime" value={running?fmtUptime(info.uptimeSec):"—"}/><InfoItem label="PID" value={info.pid?String(info.pid):"—"}/><InfoItem label="Auto-restart" value={`${info.restarts}×`}/><InfoItem label="Keluar terakhir" value={info.lastExit?`kode ${info.lastExit.code??"-"}${info.lastExit.signal?` · ${info.lastExit.signal}`:""}`:"—"}/></div>}
    {info?.nextRestartAt&&<p className="sub-hint">Restart otomatis berikutnya pukul {new Date(info.nextRestartAt).toLocaleTimeString("id-ID")}.</p>}
    <p className="sub-hint">Output install dan bot (stdout/stderr). Jika bot menampilkan QR WhatsApp, scan dari sini. Log disimpan di memori server dan hilang saat server restart.</p>
    <div className="console-tools"><button className="btn btn-secondary" onClick={clear} disabled={!lines.length}><Trash2 size={14}/> Bersihkan</button><button className="btn btn-secondary" onClick={download} disabled={!lines.length}><Download size={14}/> Unduh .txt</button></div>
    <pre className="log-view" ref={ref}>{lines.length?lines.join("\n"):"Belum ada output."}</pre></div>}
function SystemPanel(){
  const [s,setS]=useState<SystemInfo|null>(null); const [err,setErr]=useState(false);
  useEffect(()=>{ let alive=true;
    const load=async()=>{ try{const r=await api("/system"); if(!r.ok) throw new Error(); const d=await r.json(); if(alive){setS(d);setErr(false);}}catch{ if(alive)setErr(true); } };
    load(); const t=setInterval(load,5000); return()=>{alive=false;clearInterval(t);};
  },[]);
  const used=s?.disk?s.disk.totalBytes-s.disk.freeBytes:0; const pct=s?.disk&&s.disk.totalBytes?Math.round(used/s.disk.totalBytes*100):0;
  return <div className="panel settings-card system-card"><div className="settings-icon"><Gauge/></div><h3>Status server</h3>
    {!s?<p>{err?"Tidak dapat membaca status server.":"Memuat…"}</p>:<>
      <div className="system-grid"><InfoItem label="Bot aktif" value={`${s.bots.running} / ${s.bots.max}`}/><InfoItem label="Total proyek" value={String(s.bots.total)}/><InfoItem label="Uptime server" value={fmtUptime(s.serverUptimeSec)}/><InfoItem label="Memori server (RSS)" value={`${s.memoryMb} MB`}/><InfoItem label="Node.js" value={s.node}/><InfoItem label="Runner" value={s.runnerEnabled?"Aktif":"Nonaktif"}/></div>
      {s.disk?<div className="disk-usage"><div className="progress-label"><span>Penyimpanan data</span><b>{fmtBytes(used)} dari {fmtBytes(s.disk.totalBytes)} ({pct}%)</b></div><div className="progress-track"><i className={pct>=85?"warn":""} style={{width:`${pct}%`}}/></div>{pct>=85&&<p className="sub-hint">Disk hampir penuh. Hapus proyek yang tidak dipakai atau perbesar disk di hosting.</p>}</div>:<p className="sub-hint">Info disk tidak tersedia di platform ini.</p>}</>}
  </div>}
function LoginScreen({onLogin,offline}:{onLogin:(t:string,server:string)=>Promise<string|null>;offline:boolean}){
  const native=isNative();
  const [token,setTokenValue]=useState(""); const [server,setServerValue]=useState(getServer()); const [err,setErr]=useState(""); const [busy,setBusy]=useState(false);
  const canSubmit=native?!!server.trim():!!token;
  async function submit(){ setBusy(true); setErr(""); try{ const e=await onLogin(token,server); if(e)setErr(e);}catch{setErr("Tidak dapat menghubungi server.");} finally{setBusy(false);} }
  return <div className="login-wrap"><div className="panel login-card"><div className="brand-mark"><Rocket size={22}/></div><h2>BOTLAUNCH AI</h2><p>{native?"Hubungkan aplikasi ke server BOTLAUNCH Anda.":"Masukkan token akses (ADMIN_TOKEN) untuk membuka dashboard."}</p>
    {native&&<input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="https://nama-app.onrender.com" value={server} onChange={e=>setServerValue(e.target.value)}/>}
    <input type="password" autoFocus={!native} placeholder={native?"Token akses (ADMIN_TOKEN)":"Token akses"} value={token} onChange={e=>setTokenValue(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&canSubmit)submit();}}/>
    {offline&&!native&&<p className="login-err">API tidak dapat dijangkau. Pastikan server berjalan.</p>}{err&&<p className="login-err">{err}</p>}
    <button className="btn btn-primary" disabled={!canSubmit||busy} onClick={submit}>{busy?<LoaderCircle className="spin" size={16}/>:<LockKeyhole size={16}/>} {native?"Hubungkan":"Masuk"}</button></div></div>}
function EmptyState({icon:Icon,title,text}:{icon:any;title:string;text:string}){return <div className="empty-state"><div><Icon size={23}/></div><b>{title}</b><p>{text}</p></div>}
function DatabaseIcon(){return <HardDrive size={21}/>}
