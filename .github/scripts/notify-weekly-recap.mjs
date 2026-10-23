/* Notification « Résumé de la semaine » : chaque lundi à partir de 5 h (heure de Paris).
   À placer dans .github/scripts/ et à appeler depuis notify.mjs (la tâche GitHub Actions qui tourne déjà toutes les 15 minutes) :

     import { maybeSendWeeklyRecap } from './notify-weekly-recap.mjs';
     ...
     await maybeSendWeeklyRecap({ admin, db, webpush });   // admin = firebase-admin, db = admin.firestore(), webpush = web-push déjà configuré (VAPID)

   - Envoyée une seule fois par semaine : le lundi concerné est noté dans config/recapSent (champ week).
   - Seulement si la semaine écoulée avait au moins une séance (collection wods, id = date AAAA-MM-JJ).
   - À tous les appareils abonnés (pushSubs) SAUF ceux du coach (config/coach.uid), comme les autres notifications.
   - Si la tâche a du retard, l'envoi reste possible jusqu'à 12 h le lundi ; après, on ne l'envoie plus (la bannière du Fil prend le relais dans l'appli).
   - Le contenu {title, body, go, url, tag} doit suivre le format déjà utilisé par notify.mjs pour les autres notifications :
     adapte les noms de champs si push-sw.js en attend d'autres. L'appli s'ouvre sur ?go=recap. */

const TZ = 'Europe/Paris';
const FROM_HOUR = 5;
const UNTIL_HOUR = 12;

function parisNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(date).map(p => [p.type, p.value])
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: parts.weekday };
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export async function maybeSendWeeklyRecap({ admin, db, webpush }) {
  const now = parisNow();
  if (now.weekday !== 'Mon' || now.hour < FROM_HOUR || now.hour >= UNTIL_HOUR) return { sent: 0, reason: 'pas la bonne heure' };

  const thisMonday = now.day;
  const lastMonday = addDays(thisMonday, -7), lastSunday = addDays(thisMonday, -1);

  const sentRef = db.doc('config/recapSent');
  const sent = await sentRef.get();
  if (sent.exists && sent.data().week === thisMonday) return { sent: 0, reason: 'déjà envoyée' };

  /* la semaine écoulée avait-elle au moins une séance ? */
  const FP = admin.firestore.FieldPath;
  const wods = await db.collection('wods').where(FP.documentId(), '>=', lastMonday).where(FP.documentId(), '<=', lastSunday).limit(1).get();
  if (wods.empty) {
    await sentRef.set({ week: thisMonday, at: new Date().toISOString(), skipped: 'aucune séance la semaine passée' });
    return { sent: 0, reason: 'aucune séance la semaine passée' };
  }

  /* on note l'envoi AVANT d'envoyer : en cas de plantage, mieux vaut une notification manquée que des doublons toutes les 15 min */
  await sentRef.set({ week: thisMonday, at: new Date().toISOString() });

  const coach = await db.doc('config/coach').get();
  const coachUid = coach.exists ? coach.data().uid : null;

  const payload = JSON.stringify({
    title: 'Box Score · Ta semaine',
    body: 'Ton résumé de la semaine est prêt : découvre comment le classement a bougé.',
    go: 'recap',
    url: './?go=recap',
    tag: 'weekly-recap-' + thisMonday,
  });

  const subs = await db.collection('pushSubs').get();
  let ok = 0, gone = 0, fail = 0;
  await Promise.all(subs.docs.map(async d => {
    const s = d.data();
    if (!s.uid || s.uid === coachUid) return;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600 });
      ok++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { gone++; await d.ref.delete().catch(() => {}); }
      else fail++;
    }
  }));
  console.log(`Résumé de la semaine : ${ok} envoyée(s), ${gone} abonnement(s) périmé(s) supprimé(s), ${fail} échec(s).`);
  return { sent: ok, gone, fail };
}
