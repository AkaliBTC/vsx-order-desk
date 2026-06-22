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
            <span className="mono" style={{ fontSize: 13, color: 'var(--vsx-muted)' }}>{user.tag}</span>
            <button className="btn-ghost" onClick={logout}>Logout</button>
          </>
        ) : (
          <button className="btn" onClick={login}>Mit Discord anmelden</button>
        )}
      </nav>
    </header>
  );
}

function Gate({ children, mod }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="shell" style={{ paddingTop: 60 }}>Lädt…</div>;
  if (!user) return (
    <div className="shell" style={{ paddingTop: 80, textAlign: 'center' }}>
      <p className="eyebrow">Zugang</p>
      <h1 style={{ fontSize: 34, margin: '12px 0 20px' }}>Bitte mit Discord anmelden</h1>
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
        <Routes>
          <Route path="/" element={<Shop />} />
          <Route path="/ticket/:id" element={<Gate><Ticket /></Gate>} />
          <Route path="/admin" element={<Gate mod><Admin /></Gate>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
