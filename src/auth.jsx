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

  // Surface mod status + profile from the Firebase custom claims.
  useEffect(() => {
    return onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) { setUser(null); setReady(true); return; }
      const token = await fbUser.getIdTokenResult();
      setUser({
        uid: fbUser.uid,
        tag: token.claims.tag || 'Member',
        avatar: token.claims.avatar || null,
        isMod: token.claims.mod === true,
      });
      setReady(true);
    });
  }, []);

  // Handle the ?code= redirect once on load.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return;
    (async () => {
      try {
        const res = await fetch(`/api/discord-auth`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirectUri: REDIRECT_URI }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'auth failed');
        await signInWithCustomToken(auth, data.token);
      } catch (e) {
        console.error(e);
      } finally {
        window.history.replaceState({}, '', window.location.pathname);
      }
    })();
  }, []);

  return (
    <AuthCtx.Provider value={{ user, ready, login, logout: () => signOut(auth) }}>
      {children}
    </AuthCtx.Provider>
  );
}
