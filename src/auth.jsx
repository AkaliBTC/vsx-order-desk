import { createContext, useContext, useEffect, useState } from 'react';
import { signInWithCustomToken, onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from './firebase';

const DISCORD_CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;
const REDIRECT_URI = import.meta.env.VITE_DISCORD_REDIRECT_URI;
const SCOPE = 'identify guilds.members.read';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function login() {
  const url =
    'https://discord.com/oauth2/authorize?response_type=code' +
    `&client_id=${DISCORD_CLIENT_ID}` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  window.location.href = url;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [authError, setAuthError] = useState(null);

  // Profil + Mod-Status aus den Firebase Custom Claims.
  useEffect(() => {
    return onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) { setUser(null); setReady(true); return; }
      const token = await fbUser.getIdTokenResult();
      setUser({
        uid: fbUser.uid,
        tag: token.claims.tag || 'Member',
        avatar: token.claims.avatar || null,
        isMod: token.claims.mod === true || token.claims.admin === true,
        isAdmin: token.claims.admin === true,
        owns: Array.isArray(token.claims.owns) ? token.claims.owns : [],
        loyalty: token.claims.loyalty === true,
      });
      setReady(true);
    });
  }, []);

  // ?code= vom Discord-Redirect einmalig verarbeiten.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return;
    (async () => {
      try {
        const res = await fetch('/api/discord-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirectUri: REDIRECT_URI }),
        });
        const text = await res.text();
        let data = {};
        try { data = JSON.parse(text); } catch (_) {
          throw new Error('Unreadable server response: ' + text.slice(0, 140));
        }
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        if (!data.token) throw new Error('No token received');
        await signInWithCustomToken(auth, data.token);
        setAuthError(null);
      } catch (e) {
        setAuthError(e.message || 'Login failed');
        console.error('Login-Fehler:', e);
      } finally {
        window.history.replaceState({}, '', window.location.pathname);
      }
    })();
  }, []);

  return (
    <AuthCtx.Provider value={{ user, ready, authError, login, logout: () => signOut(auth) }}>
      {children}
    </AuthCtx.Provider>
  );
}
