import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth, login } from './auth';
import Shop from './pages/Shop';
import Ticket from './pages/Ticket';
import Admin from './pages/Admin';

function Header() {
  const { user, logout } = useAuth();
  return (
    <header style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '22px 24px', maxWidth: 1080, margin: '0 auto',
    }}>
      <Link to="/" style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="display" style={{ fontSize: 26, color: 'var(--vsx-gold)' }}>VISIONX</span>
        <span className="eyebrow">Order Desk</span>
      </Link>
      <nav style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {user?.isMod && <Link to="/admin" className="tag gold">Admin</Link>}
        {user ? (
          <>
            {user.avatar && (
              <img src={user.avatar} alt="" width={28} height={28}
                style={{ borderRadius: '50%', border: '1px solid var(--vsx-line)' }} />
            )}
            <span className="mono" style={{ fontSize: 13 }}>{user.tag}</span>
            <button className="btn-ghost" onClick={logout}>Abmelden</button>
          </>
        ) : (
          <button className="btn" onClick={login}>Mit Discord anmelden</button>
        )}
      </nav>
    </header>
  );
}

function ErrorBanner() {
  const { authError } = useAuth();
  if (!authError) return null;
  return (
    <div className="shell" style={{ paddingBottom: 0 }}>
      <div style={{
        background: 'rgba(192,83,63,.12)', border: '1px solid #5b2e26',
        borderRadius: 10, padding: '12px 16px', color: '#e7a08f', fontSize: 14,
      }}>
        <b>Login-Fehler:</b> <span className="mono">{authError}</span>
      </div>
    </div>
  );
}

function Gate({ children, mod }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="shell" style={{ paddingTop: 60 }}>Lädt…</div>;
  if (!user) return (
    <div className="shell" style={{ paddingTop: 80, textAlign: 'center' }}>
      <p className="eyebrow">Zugang</p>
      <h1 style={{ fontSize: 34, margin: '12px 0 10px' }}>Willkommen bei VisionX</h1>
      <p style={{ color: 'var(--vsx-muted)', marginBottom: 24 }}>
        Bitte melde dich mit Discord an, um die Analysepakete zu sehen.
      </p>
      <button className="btn" onClick={login}>Mit Discord anmelden</button>
    </div>
  );
  if (mod && !user.isMod) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Header />
        <ErrorBanner />
        <Routes>
          <Route path="/" element={<Gate><Shop /></Gate>} />
          <Route path="/ticket/:id" element={<Gate><Ticket /></Gate>} />
          <Route path="/admin" element={<Gate mod><Admin /></Gate>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
