/* Recopie l'état des abonnements Stripe dans Firestore : subs/{uid} = { active, status, plan, periodEnd, cancelAtPeriodEnd, ... }.
   Lancé régulièrement par .github/workflows/stripe-sync.yml. L'appli lit ce document (lecture seule) pour ouvrir ou bloquer l'accès aux séances.
   Le lien entre un paiement et un compte vient de client_reference_id (identifiant du compte), ajouté à l'adresse du lien de paiement par l'appli. */
import admin from 'firebase-admin';
import Stripe from 'stripe';

const need = n => { const v = process.env[n]; if (!v) { console.error('Secret manquant : ' + n); process.exit(1); } return v; };
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(need('FIREBASE_SERVICE_ACCOUNT'))) });
const db = admin.firestore();
const stripe = new Stripe(need('STRIPE_SECRET_KEY'));

const LOOKBACK_DAYS = Number(process.env.STRIPE_LOOKBACK_DAYS || 30); /* paiements récents à examiner (premier lancement : mets 365) */
const ACTIVE = new Set(['active', 'trialing']);

/* 1) abonnement -> compte : abonnements déjà connus (Firestore) + paiements Checkout récents */
const subToUid = new Map();
const known = await db.collection('subs').get();
known.forEach(d => { const x = d.data(); if (x.subId) subToUid.set(x.subId, d.id); });
const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 86400;
for await (const s of stripe.checkout.sessions.list({ limit: 100, created: { gte: since } })) {
  if (s.status === 'complete' && s.mode === 'subscription' && s.client_reference_id && s.subscription) {
    subToUid.set(typeof s.subscription === 'string' ? s.subscription : s.subscription.id, s.client_reference_id);
  }
}

/* 2) état actuel de tous les abonnements Stripe */
const subs = new Map();
for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) subs.set(sub.id, sub);

const planOf = sub => {
  const pr = sub.items && sub.items.data[0] && sub.items.data[0].price;
  const r = pr && pr.recurring;
  if (r && r.interval === 'week' && r.interval_count === 4) return '4w';
  if (r && r.interval === 'week' && r.interval_count === 12) return 'season';
  return (pr && pr.id) || '';
};
const endOf = sub => {
  const t = sub.current_period_end ?? (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end);
  return t ? new Date(t * 1000).toISOString() : '';
};

/* 3) un seul abonnement retenu par compte : un abonnement actif d'abord, sinon le plus récent */
const byUid = new Map();
for (const [subId, uid] of subToUid) {
  const sub = subs.get(subId);
  if (!sub) continue;
  const cur = byUid.get(uid);
  const better = !cur || (ACTIVE.has(sub.status) && !ACTIVE.has(cur.status)) || (ACTIVE.has(sub.status) === ACTIVE.has(cur.status) && sub.created > cur.created);
  if (better) byUid.set(uid, sub);
}

let written = 0, same = 0;
for (const [uid, sub] of byUid) {
  const doc = {
    subId: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || '',
    status: sub.status,
    active: ACTIVE.has(sub.status),
    plan: planOf(sub),
    periodEnd: endOf(sub),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end
  };
  const ref = db.doc('subs/' + uid);
  const old = (await ref.get()).data() || {};
  if (Object.keys(doc).every(k => old[k] === doc[k])) { same++; continue; }
  await ref.set({ ...doc, updatedAt: new Date().toISOString() });
  written++;
}
console.log(`Abonnements : ${byUid.size} · mis à jour : ${written} · inchangés : ${same}`);
