// Returns the caller's referral code (creating a unique one on first call) + use count.
import admin from 'firebase-admin';

function getAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin;
}

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  return `VSX-${block()}-${block()}`;
}

export default async function handler(req, res) {
  try {
    const authz = req.headers.authorization || '';
    const idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'no token' });
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    const userId = decoded.uid;
    const db = getAdmin().firestore();

    // Already have one?
    const existing = await db.collection('referrals').where('ownerId', '==', userId).limit(1).get();
    if (!existing.empty) {
      const d = existing.docs[0];
      return res.json({ code: d.id, uses: d.data().uses || 0 });
    }

    // Create a unique one.
    let code = '';
    for (let i = 0; i < 6; i++) {
      const c = genCode();
      const snap = await db.collection('referrals').doc(c).get();
      if (!snap.exists) { code = c; break; }
    }
    if (!code) return res.status(500).json({ error: 'could not allocate code' });
    await db.collection('referrals').doc(code).set({
      ownerId: userId, uses: 0, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ code, uses: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message || 'referral failed' });
  }
}
