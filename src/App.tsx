import { useEffect, useState } from "react";

type Page = "dashboard" | "devices" | "sessions" | "security" | "settings";

type DeviceStatus = {
  online: boolean;
  displayName: string;
  os: string;
  lastSeen: string | null;
  agentVersion: string | null;
};

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
};

function formatLastSeen(value: string | null, online: boolean) {
  if (online) return "الآن";
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("ar-EG", {
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

function DeviceCard({ device }: { device: DeviceStatus }) {
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
        <div><span>Remote Engine</span><strong>RustDesk / المرحلة التالية</strong></div>
        <div><span>Agent</span><strong>{device.online ? `متصل ${device.agentVersion ? `v${device.agentVersion}` : ""}` : "بانتظار الاتصال"}</strong></div>
        <div><span>آخر ظهور</span><strong>{formatLastSeen(device.lastSeen, device.online)}</strong></div>
      </div>

      <div className="device-actions">
        <button className="connect" disabled>اتصال عن بعد</button>
        <button className="secondary">معلومات الجهاز</button>
      </div>

      <p className="hint">
        {device.online
          ? "Agent متصل بمنصة Railway بنجاح. سيتم تفعيل التحكم بالشاشة والماوس والكيبورد في المرحلة التالية."
          : "شغّل MAGHRABI Remote Agent على جهاز المنزل ليتحول الجهاز إلى Online."}
      </p>
    </article>
  );
}

function Dashboard() {
  const [device, setDevice] = useState<DeviceStatus>(initialDevice);
  const [apiReady, setApiReady] = useState(false);

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
          <strong>V0.2</strong>
          <small>{apiReady ? "Railway API جاهز للـ Agent" : "جارٍ الاتصال بالخادم"}</small>
        </div>
      </section>

      <section className="stats">
        <div className="stat"><span>الأجهزة</span><strong>1</strong><small>جهاز شخصي</small></div>
        <div className="stat"><span>المتصل الآن</span><strong>{device.online ? "1" : "0"}</strong><small>{device.online ? "HOME-PC Online" : "بانتظار Agent"}</small></div>
        <div className="stat"><span>الجلسات اليوم</span><strong>0</strong><small>Remote Desktop قريبًا</small></div>
        <div className="stat"><span>الخادم</span><strong>{apiReady ? "جاهز" : "..."}</strong><small>Railway Production</small></div>
      </section>

      <div className="section-title">
        <div><span>MY DEVICES</span><h2>أجهزتي</h2></div>
      </div>
      <DeviceCard device={device} />
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

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [menuOpen, setMenuOpen] = useState(false);

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
          <strong>منصة شخصية</strong>
          <p>Agent يستخدم Bearer Token لا يتم حفظه داخل GitHub أو واجهة React.</p>
        </div>
      </aside>

      <main>
        <header>
          <div className="header-title">
            <button className="menu" onClick={() => setMenuOpen(true)}>☰</button>
            <div><span>MAGHRABI REMOTE</span><h1>{labels[page]}</h1></div>
          </div>
          <div className="owner"><span className="owner-dot" /><div><strong>مالك النظام</strong><small>Private Account</small></div></div>
        </header>

        <div className="content">
          {page === "dashboard" || page === "devices" ? <Dashboard /> : <Placeholder page={page} />}
        </div>
      </main>
    </div>
  );
}
