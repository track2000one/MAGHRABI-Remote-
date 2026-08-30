import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import "./remote.css";

type Page = "dashboard" | "devices" | "sessions" | "security" | "settings";

type DeviceStatus = {
  online: boolean;
  displayName: string;
  os: string;
  lastSeen: string | null;
  agentVersion: string | null;
  sessionsToday?: number;
};

type AuthStatus = {
  configured: boolean;
  authenticated: boolean;
};

type MouseButton = "left" | "middle" | "right";
type InputAction = "down" | "up";
type RemoteInputEvent =
  | { type: "move"; x: number; y: number }
  | { type: "button"; button: MouseButton; action: InputAction }
  | { type: "wheel"; delta: number }
  | { type: "key"; code: string; action: InputAction }
  | { type: "release" };

const labels: Record<Page, string> = {
  dashboard: "لوحة التحكم",
  devices: "أجهزتي",
  sessions: "سجل الجلسات",
  security: "الأمان",
  settings: "الإعدادات",
};

const nav: { id: Page; icon: string; label: string }[] = [
  { id: "dashboard", icon: "⌂", label: "لوحة التحكم" },
  { id: "devices", icon: "▣", label: "أجهزتي" },
  { id: "sessions", icon: "◷", label: "سجل الجلسات" },
  { id: "security", icon: "◇", label: "الأمان" },
  { id: "settings", icon: "⚙", label: "الإعدادات" },
];

const initialDevice: DeviceStatus = {
  online: false,
  displayName: "HOME-PC",
  os: "Windows PC",
  lastSeen: null,
  agentVersion: null,
  sessionsToday: 0,
};

function formatLastSeen(value: string | null, online: boolean) {
  if (online) return "الآن";
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("ar-SA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function LoginScreen({ configured, onLogin }: { configured: boolean; onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!configured) {
    return (
      <div className="auth-shell">
        <section className="auth-card setup-card">
          <div className="auth-logo">M</div>
          <span className="auth-kicker">SECURITY SETUP REQUIRED</span>
          <h1>فعّل حماية المالك أولًا</h1>
          <p>قبل التحكم بجهاز المنزل، أضف متغير البيئة التالي في Railway ثم انتظر إعادة النشر:</p>
          <code>MAGHRABI_OWNER_PASSWORD</code>
          <small>استخدم كلمة مرور قوية ومختلفة عن كلمة مرور Windows وRustDesk. لا تحفظها داخل GitHub.</small>
        </section>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        setError(response.status === 429 ? "محاولات كثيرة. حاول لاحقًا." : "كلمة المرور غير صحيحة.");
        return;
      }
      setPassword("");
      onLogin();
    } catch {
      setError("تعذر الاتصال بالخادم.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">M</div>
        <span className="auth-kicker">MAGHRABI REMOTE</span>
        <h1>دخول مالك النظام</h1>
        <p>تسجيل الدخول مطلوب قبل الوصول إلى HOME-PC أو إرسال أي إدخال عن بعد.</p>
        <label>
          <span>كلمة المرور</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button className="auth-submit" type="submit" disabled={loading}>
          {loading ? "جارٍ التحقق..." : "دخول آمن"}
        </button>
      </form>
    </div>
  );
}

function RemoteSession({ device, onClose }: { device: DeviceStatus; onClose: () => void }) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("بانتظار أول صورة من Agent...");
  const [connected, setConnected] = useState(true);
  const [controlFocused, setControlFocused] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const inputQueueRef = useRef<RemoteInputEvent[]>([]);
  const pendingMoveRef = useRef<RemoteInputEvent | null>(null);
  const flushingRef = useRef(false);

  const enqueueInput = (event: RemoteInputEvent) => {
    if (event.type === "move") {
      pendingMoveRef.current = event;
      return;
    }

    if (pendingMoveRef.current) {
      inputQueueRef.current.push(pendingMoveRef.current);
      pendingMoveRef.current = null;
    }
    inputQueueRef.current.push(event);
    if (inputQueueRef.current.length > 96) inputQueueRef.current.splice(0, inputQueueRef.current.length - 96);
  };

  const flushInput = async () => {
    if (flushingRef.current) return;
    if (pendingMoveRef.current) {
      inputQueueRef.current.push(pendingMoveRef.current);
      pendingMoveRef.current = null;
    }
    if (!inputQueueRef.current.length) return;

    const events = inputQueueRef.current.splice(0, 32);
    flushingRef.current = true;
    try {
      const response = await fetch("/api/session/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 409) setConnected(false);
    } catch {
      setConnected(false);
    } finally {
      flushingRef.current = false;
    }
  };

  useEffect(() => {
    let active = true;
    let currentUrl: string | null = null;

    const keepAlive = async () => {
      try {
        const response = await fetch("/api/session/keepalive", { method: "POST", cache: "no-store" });
        if (active) setConnected(response.ok);
      } catch {
        if (active) setConnected(false);
      }
    };

    const loadFrame = async () => {
      try {
        const response = await fetch(`/api/session/frame?t=${Date.now()}`, { cache: "no-store" });
        if (response.status === 204) {
          if (active) setMessage("Agent متصل — جارٍ تجهيز لقطة الشاشة...");
          return;
        }
        if (response.status === 401) {
          if (active) {
            setConnected(false);
            setMessage("انتهت جلسة تسجيل الدخول.");
          }
          return;
        }
        if (!response.ok) throw new Error("frame unavailable");
        const blob = await response.blob();
        const nextUrl = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = nextUrl;
        setFrameUrl(nextUrl);
        setMessage("");
      } catch {
        if (active) setMessage("تعذر استلام صورة الشاشة مؤقتًا...");
      }
    };

    keepAlive();
    loadFrame();
    const keepAliveTimer = window.setInterval(keepAlive, 10_000);
    const frameTimer = window.setInterval(loadFrame, 1_200);

    return () => {
      active = false;
      window.clearInterval(keepAliveTimer);
      window.clearInterval(frameTimer);
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      fetch("/api/session/stop", { method: "POST", keepalive: true }).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void flushInput(), 50);
    return () => {
      window.clearInterval(timer);
      enqueueInput({ type: "release" });
      void flushInput();
    };
  }, []);

  const fullscreen = async () => {
    try {
      await screenRef.current?.requestFullscreen();
      screenRef.current?.focus({ preventScroll: true });
    } catch {
      // Browser may deny fullscreen when not initiated by the user.
    }
  };

  const pointerPosition = (clientX: number, clientY: number) => {
    const container = screenRef.current;
    const image = imageRef.current;
    if (!container || !image || !image.naturalWidth || !image.naturalHeight) return null;

    const rect = container.getBoundingClientRect();
    const imageAspect = image.naturalWidth / image.naturalHeight;
    let renderWidth = rect.width;
    let renderHeight = renderWidth / imageAspect;
    if (renderHeight > rect.height) {
      renderHeight = rect.height;
      renderWidth = renderHeight * imageAspect;
    }

    const left = rect.left + (rect.width - renderWidth) / 2;
    const top = rect.top + (rect.height - renderHeight) / 2;
    if (clientX < left || clientX > left + renderWidth || clientY < top || clientY > top + renderHeight) return null;

    return {
      x: Math.max(0, Math.min(1, (clientX - left) / renderWidth)),
      y: Math.max(0, Math.min(1, (clientY - top) / renderHeight)),
    };
  };

  const queuePointerMove = (clientX: number, clientY: number) => {
    const point = pointerPosition(clientX, clientY);
    if (point) enqueueInput({ type: "move", ...point });
    return point;
  };

  const buttonName = (button: number): MouseButton | null => {
    if (button === 0) return "left";
    if (button === 1) return "middle";
    if (button === 2) return "right";
    return null;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    queuePointerMove(event.clientX, event.clientY);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignored */ }
    queuePointerMove(event.clientX, event.clientY);
    const button = buttonName(event.button);
    if (button) enqueueInput({ type: "button", button, action: "down" });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    queuePointerMove(event.clientX, event.clientY);
    const button = buttonName(event.button);
    if (button) enqueueInput({ type: "button", button, action: "up" });
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignored */ }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    queuePointerMove(event.clientX, event.clientY);
    const delta = event.deltaY === 0 ? 0 : Math.sign(-event.deltaY) * 120;
    if (delta) enqueueInput({ type: "wheel", delta });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.isComposing || !event.code) return;
    event.preventDefault();
    event.stopPropagation();
    enqueueInput({ type: "key", code: event.code, action: "down" });
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.isComposing || !event.code) return;
    event.preventDefault();
    event.stopPropagation();
    enqueueInput({ type: "key", code: event.code, action: "up" });
  };

  const handleBlur = () => {
    setControlFocused(false);
    enqueueInput({ type: "release" });
  };

  return (
    <div className="remote-overlay">
      <section className="remote-window">
        <div className="remote-toolbar">
          <div>
            <span className={`remote-dot ${connected ? "online" : ""}`} />
            <strong>{device.displayName}</strong>
            <small>V2.2 · تحكم بالماوس والكيبورد</small>
          </div>
          <div className="remote-actions">
            <span className={`control-badge ${controlFocused ? "active" : ""}`}>
              {controlFocused ? "● التحكم نشط" : "انقر داخل الشاشة للتحكم"}
            </span>
            <button onClick={fullscreen}>⛶ ملء الشاشة</button>
            <button className="danger" onClick={onClose}>قطع الاتصال</button>
          </div>
        </div>

        <div
          className={`remote-screen ${controlFocused ? "control-focused" : ""}`}
          ref={screenRef}
          tabIndex={0}
          onFocus={() => setControlFocused(true)}
          onBlur={handleBlur}
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onContextMenu={(event) => event.preventDefault()}
        >
          {frameUrl ? (
            <>
              <img ref={imageRef} src={frameUrl} alt={`شاشة ${device.displayName}`} draggable={false} />
              {!controlFocused && <div className="remote-control-hint">انقر داخل الشاشة لتفعيل الماوس والكيبورد</div>}
            </>
          ) : (
            <div className="remote-waiting">
              <div className="remote-spinner" />
              <strong>{message}</strong>
              <span>يتم التقاط الشاشة وإرسال الإدخال فقط أثناء جلسة المالك المصادق عليها.</span>
            </div>
          )}
        </div>

        <div className="remote-footer">
          <span>🔒 HTTPS + Owner Session + Agent Token</span>
          <span>Mouse / Keyboard: {connected ? "Enabled" : "Reconnecting"}</span>
          <span>Ctrl+Alt+Del وشاشة UAC غير مدعومين في V2.2</span>
        </div>
      </section>
    </div>
  );
}

function DeviceCard({ device, onConnect, connecting }: { device: DeviceStatus; onConnect: () => void; connecting: boolean }) {
  return (
    <article className="device-card">
      <div className="device-top">
        <div className="computer-icon">▰</div>
        <div>
          <div className="device-title-row">
            <h3>{device.displayName || "HOME-PC"}</h3>
            <span
              className={`status ${device.online ? "" : "pending"}`}
              style={device.online ? {
                background: "rgba(66,215,162,.1)",
                color: "#55e2b1",
                border: "1px solid rgba(66,215,162,.16)",
              } : undefined}
            >
              {device.online ? "متصل الآن" : "غير متصل"}
            </span>
          </div>
          <p>{device.os || "Windows PC"} · الجهاز المنزلي</p>
        </div>
      </div>

      <div className="device-details">
        <div><span>Remote Engine</span><strong>MAGHRABI Control V2.2</strong></div>
        <div><span>Agent</span><strong>{device.online ? `متصل ${device.agentVersion ? `v${device.agentVersion}` : ""}` : "بانتظار الاتصال"}</strong></div>
        <div><span>آخر ظهور</span><strong>{formatLastSeen(device.lastSeen, device.online)}</strong></div>
      </div>

      <div className="device-actions">
        <button className="connect" disabled={!device.online || connecting} onClick={onConnect}>
          {connecting ? "جارٍ بدء الجلسة..." : "اتصال وتحكم"}
        </button>
        <button className="secondary">معلومات الجهاز</button>
      </div>

      <p className="hint">
        {device.online
          ? "V2.2 يتيح عرض الشاشة والتحكم بالماوس والكيبورد من المتصفح بعد تسجيل دخول المالك."
          : "شغّل MAGHRABI Remote Agent V2.2 على جهاز المنزل لبدء جلسة التحكم."}
      </p>
    </article>
  );
}

function Dashboard() {
  const [device, setDevice] = useState<DeviceStatus>(initialDevice);
  const [apiReady, setApiReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [connectError, setConnectError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/device-status", { cache: "no-store" });
        if (!response.ok) throw new Error("API unavailable");
        const data = (await response.json()) as DeviceStatus;
        if (active) {
          setDevice(data);
          setApiReady(true);
        }
      } catch {
        if (active) setApiReady(false);
      }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const connect = async () => {
    setConnecting(true);
    setConnectError("");
    try {
      const response = await fetch("/api/session/start", { method: "POST", cache: "no-store" });
      if (!response.ok) {
        setConnectError(response.status === 409 ? "الجهاز غير متصل حاليًا." : "تعذر بدء جلسة التحكم.");
        return;
      }
      setRemoteOpen(true);
    } catch {
      setConnectError("تعذر الاتصال بالخادم.");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <section className="hero">
        <div>
          <span className="kicker">PRIVATE REMOTE ACCESS</span>
          <h2>الوصول إلى جهازك المنزلي<br />من أي مكان، بأمان.</h2>
          <p>MAGHRABI Remote منصة شخصية لإدارة الاتصال بجهازك عن بعد.</p>
        </div>
        <div className="hero-badge">
          <span>حالة النظام</span>
          <strong>V2.2</strong>
          <small>{apiReady ? "Mouse + Keyboard جاهز" : "جارٍ الاتصال بالخادم"}</small>
        </div>
      </section>

      <section className="stats">
        <div className="stat"><span>الأجهزة</span><strong>1</strong><small>جهاز شخصي</small></div>
        <div className="stat"><span>المتصل الآن</span><strong>{device.online ? "1" : "0"}</strong><small>{device.online ? "HOME-PC Online" : "بانتظار Agent"}</small></div>
        <div className="stat"><span>الجلسات اليوم</span><strong>{device.sessionsToday ?? 0}</strong><small>جلسات Remote</small></div>
        <div className="stat"><span>الوضع</span><strong>Control</strong><small>Screen + Mouse + Keyboard</small></div>
      </section>

      <div className="section-title">
        <div><span>MY DEVICES</span><h2>أجهزتي</h2></div>
      </div>
      {connectError && <div className="connect-error">{connectError}</div>}
      <DeviceCard device={device} onConnect={connect} connecting={connecting} />
      {remoteOpen && <RemoteSession device={device} onClose={() => setRemoteOpen(false)} />}
    </>
  );
}

function Placeholder({ page }: { page: Page }) {
  return (
    <section className="placeholder">
      <div className="placeholder-icon">{nav.find((item) => item.id === page)?.icon}</div>
      <h2>{labels[page]}</h2>
      <p>هذه الوحدة جاهزة للتطوير ضمن المرحلة التالية من MAGHRABI Remote.</p>
    </section>
  );
}

function MainPlatform({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<Page>("dashboard");
  const [menuOpen, setMenuOpen] = useState(false);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  };

  return (
    <div className="app">
      <div className={`overlay ${menuOpen ? "show" : ""}`} onClick={() => setMenuOpen(false)} />
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="logo">M</div>
          <div><strong>MAGHRABI</strong><span>REMOTE</span></div>
        </div>

        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => { setPage(item.id); setMenuOpen(false); }}
            >
              <i>{item.icon}</i><span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="security-card">
          <span>SECURITY</span>
          <strong>جلسة مالك محمية</strong>
          <p>التحكم لا يعمل إلا أثناء جلسة مالك نشطة، والـAgent يقبل إدخالًا محدودًا للماوس والكيبورد فقط.</p>
        </div>
      </aside>

      <main>
        <header>
          <div className="header-title">
            <button className="menu" onClick={() => setMenuOpen(true)}>☰</button>
            <div><span>MAGHRABI REMOTE</span><h1>{labels[page]}</h1></div>
          </div>
          <button className="owner owner-button" onClick={logout} title="تسجيل الخروج">
            <span className="owner-dot" />
            <div><strong>مالك النظام</strong><small>تسجيل الخروج</small></div>
          </button>
        </header>

        <div className="content">
          {page === "dashboard" || page === "devices" ? <Dashboard /> : <Placeholder page={page} />}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  const refreshAuth = async () => {
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      const data = (await response.json()) as AuthStatus;
      setAuth(data);
    } catch {
      setAuth({ configured: false, authenticated: false });
    }
  };

  useEffect(() => {
    refreshAuth();
  }, []);

  if (!auth) {
    return <div className="auth-shell"><div className="remote-spinner" /></div>;
  }

  if (!auth.authenticated) {
    return <LoginScreen configured={auth.configured} onLogin={() => setAuth({ ...auth, authenticated: true })} />;
  }

  return <MainPlatform onLogout={() => setAuth({ ...auth, authenticated: false })} />;
}
