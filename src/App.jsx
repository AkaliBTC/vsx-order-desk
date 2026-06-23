import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth, login } from './auth';
import Shop from './pages/Shop';
import Ticket from './pages/Ticket';
import Admin from './pages/Admin';

function Header() {
  const { user, logout } = useAuth();
  if (!user) return null; // clean, full-screen login — no header button
  return (
    <header style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '22px 24px', maxWidth: 1080, margin: '0 auto',
    }}>
      <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <img src="/logo.png" alt="VisionX" height={34} style={{ display: 'block' }} />
        <span className="display" style={{ fontSize: 26, color: 'var(--vsx-gold)' }}>VISIONX</span>
        <span className="eyebrow">Order Desk</span>
      </Link>
      <nav style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {user.isMod && <Link to="/admin" className="tag" style={{ borderColor: 'var(--vsx-gold-2)', color: 'var(--vsx-gold)' }}>Dashboard</Link>}
        {user.isAdmin
          ? <span className="tag gold">Admin</span>
          : user.isMod ? <span className="tag" style={{ color: '#7aa2f7', borderColor: '#34406b' }}>Moderator</span> : null}
        {user.avatar && (
          <img src={user.avatar} alt="" width={28} height={28}
            style={{ borderRadius: '50%', border: '1px solid var(--vsx-line)' }} />
        )}
        <span className="mono" style={{ fontSize: 13 }}>{user.tag}</span>
        <button className="btn-ghost" onClick={logout}>Logout</button>
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
        <b>Login error:</b> <span className="mono">{authError}</span>
      </div>
    </div>
  );
}

function DiscordButton({ onClick, big }) {
  return (
    <button className="btn" onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: big ? '15px 28px' : '12px 22px', fontSize: big ? 15 : 14 }}>
      <svg width={big ? 21 : 18} height={big ? 21 : 18} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.198.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
      </svg>
      Sign in with Discord
    </button>
  );
}

function Gate({ children, mod }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="shell" style={{ paddingTop: 60 }}>Loading…</div>;
  if (!user) return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '40px 20px', position: 'relative', overflow: 'hidden' }}>
      <div aria-hidden style={{ position: 'absolute', top: '34%', left: '50%', width: 560, height: 560, transform: 'translate(-50%,-50%)', background: 'radial-gradient(circle, rgba(212,175,55,.16), transparent 62%)', pointerEvents: 'none' }} />
      <img className="floaty" src="/logo.png" alt="VisionX" height={112}
        style={{ marginBottom: 30, filter: 'drop-shadow(0 22px 60px rgba(212,175,55,.32))', position: 'relative' }} />
      <p className="eyebrow rise" style={{ animationDelay: '.05s' }}>Access</p>
      <h1 className="rise" style={{ fontSize: 42, letterSpacing: '.02em', margin: '14px 0 14px', animationDelay: '.12s' }}>Welcome to VisionX</h1>
      <p className="rise" style={{ color: 'var(--vsx-muted)', maxWidth: 430, lineHeight: 1.65, marginBottom: 32, animationDelay: '.19s' }}>
        Sign in with Discord to access your analysis packages, tracker and services.
      </p>
      <div className="rise" style={{ animationDelay: '.26s' }}>
        <DiscordButton onClick={login} big />
      </div>
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
