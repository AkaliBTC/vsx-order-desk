import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import { DEFAULT_CATALOGUE } from './data';

// Live catalogue from Firestore (config/catalogue), editable in Admin.
export function useCatalogue() {
  const [cat, setCat] = useState(DEFAULT_CATALOGUE);
  useEffect(() => onSnapshot(doc(db, 'config', 'catalogue'), (s) => {
    if (s.exists()) setCat({ ...DEFAULT_CATALOGUE, ...s.data() });
    else setCat(DEFAULT_CATALOGUE);
  }), []);
  return cat;
}
