import { useState } from "react";

type Page = "dashboard" | "devices" | "sessions" | "security" | "settings";

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

function DeviceCard() {
  return (
    <article className="device-card">
      <div className="device-top">
        <div className="computer-icon">▰</div>
        <div>
          <div className="device-title-row">
            <h3>HOME-PC</h3>
            <span className="status pending">غير مربوط</span>
          </div>
          <p>Windows PC · الجهاز المنزلي</p>
        </div>
      </div>

      <div className="device-details">
        <div><span>Remote Engine</span><strong>RustDesk</strong></div>
        <div><span>Agent</span><strong>بانتظار الربط</strong></div>
        <div><span>آخر ظهور</span><strong>—</strong></div>
      </div>

      <div className="device-actions">
        <button className="connect" disabled>اتصال عن بعد</button>
        <button className="secondary">إعداد الجهاز</button>
      </div>

      <p className="hint">سيتم تفعيل الاتصال بعد ربط Agent بالخادم. لا يتم حفظ كلمة مرور RustDesk داخل الواجهة.</p>
    </article>
  );
}

function Dashboard() {
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
          <strong>V0.1</strong>
          <small>واجهة أولية جاهزة للربط</small>
        </div>
      </section>

      <section className="stats">
        <div className="stat"><span>الأجهزة</span><strong>1</strong><small>جهاز مسجل</small></div>
        <div className="stat"><span>المتصل الآن</span><strong>0</strong><small>بانتظار Agent</small></div>
        <div className="stat"><span>الجلسات اليوم</span><strong>0</strong><small>لا توجد جلسات</small></div>
        <div className="stat"><span>الأمان</span><strong>جاهز</strong><small>لا توجد أسرار في الواجهة</small></div>
      </section>

      <div className="section-title">
        <div><span>MY DEVICES</span><h2>أجهزتي</h2></div>
      </div>
      <DeviceCard />
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
          <p>سيتم دعم 2FA والأجهزة الموثوقة وسجل جميع الاتصالات.</p>
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
