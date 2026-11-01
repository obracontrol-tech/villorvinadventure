// VillorvinAdventure — Worker de avisos SOS con la app cerrada (Cloudflare)
// Nombre del Worker: villorvinadventure-push  →  https://villorvinadventure-push.pedrosaborrego.workers.dev
// v2.6: proyecto propio de VillorvinAdventure (ya no usa nada de RideSafe IA)
// Secretos (Settings → Variables and Secrets):
//   FIREBASE_SA  = el contenido COMPLETO del archivo JSON de la cuenta de servicio de Firebase
//   FIREBASE_KEY = la "Browser key" (apiKey) de Firebase: AIzaSy...
//
// Qué hace: la app guarda la alerta en el chat del club y llama a este Worker con el id del mensaje.
// El Worker comprueba que la alerta es real (quién la envía, que es reciente y que es del club),
// busca los móviles de los administradores del club y les manda la notificación push.

const PROJECT = 'villorvinadventure-38c74';
const ORIGINS = ['https://app.villorvinadventure.com'];
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return out({ ok: true, info: 'villorvin-push activo' });
    try {
      const { idToken, club, msg } = await req.json();
      if (!idToken || !/^[A-Z0-9]{6}$/.test(club || '') || !/^[A-Za-z0-9]{10,40}$/.test(msg || '')) return out({ error: 'datos' }, 400);

      // 1. ¿Quién llama? (token de Firebase de la app)
      const lk = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
      }).then(r => r.json());
      const uid = lk.users && lk.users[0] && lk.users[0].localId;
      if (!uid) return out({ error: 'auth' }, 401);

      const tok = await googleToken(env);
      const H = { Authorization: 'Bearer ' + tok };

      // 2. La alerta tiene que existir, ser de quien llama, reciente y no enviada ya
      const mRes = await fetch(`${FS}/groups/${club}/msgs/${msg}`, { headers: H });
      if (!mRes.ok) return out({ error: 'mensaje' }, 404);
      const m = (await mRes.json()).fields || {};
      const text = sv(m.text), from = sv(m.uid), ts = Number(sv(m.ts) || 0);
      if (from !== uid) return out({ error: 'autor' }, 403);
      if (!text.startsWith('🆘 ALERTA')) return out({ error: 'tipo' }, 400);
      if (Date.now() - ts > 10 * 60 * 1000) return out({ error: 'antiguo' }, 400);
      if (m.pushed) return out({ ok: true, repetido: true });
      await fetch(`${FS}/groups/${club}/msgs/${msg}?updateMask.fieldPaths=pushed`, {
        method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { pushed: { booleanValue: true } } })
      });

      // 3. Administradores del club (creador + administradores + jefes de pelotón)
      const gRes = await fetch(`${FS}/groups/${club}`, { headers: H });
      if (!gRes.ok) return out({ error: 'club' }, 404);
      const g = (await gRes.json()).fields || {};
      if (!keys(g.members).includes(uid)) return out({ error: 'no es del club' }, 403);
      const org = new Set([sv(g.byUid), ...keys(g.admins), ...keys(g.captains)].filter(Boolean));
      org.delete(uid);

      // 4. Móviles de la organización con los avisos activados
      const tokens = [];
      for (const a of org) {
        const p = await fetch(`${FS}/users/${a}/private/push`, { headers: H });
        if (p.ok) tokens.push(...keys(((await p.json()).fields || {}).tokens));
      }
      if (!tokens.length) return out({ ok: true, enviados: 0, info: 'la organización no tiene activados los avisos con la app cerrada' });

      // 5. Aviso: "Ana Roca: ACCIDENTE"
      const parts = text.split(' · ');
      const kind = (parts[1] || 'AVISO').replace(/^[^A-ZÁÉÍÓÚÑ]+/u, '');
      const name = parts[2] || 'Un ciclista';
      const tel = (text.match(/📞 ([+0-9 ]{9,20})/) || [])[1] || '';
      const body = (tel ? 'Tel. ' + tel.trim() + '. ' : '') + 'Toca para ver dónde está y gestionarlo.';
      let n = 0;
      for (const t of tokens) {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
          method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: {
            token: t,
            data: { title: 'SOS VillorvinAdventure · ' + name + ': ' + kind, body, url: './', urgent: '1', tag: 'va-sos' },
            webpush: { headers: { Urgency: 'high', TTL: '900' } }
          } })
        });
        if (r.ok) n++;
      }
      return out({ ok: true, enviados: n });
    } catch (e) {
      return out({ error: String(e && e.message || e) }, 500);
    }
  }
};

const sv = f => f ? (f.stringValue ?? f.integerValue ?? f.doubleValue ?? '') : '';
const keys = f => Object.keys((f && f.mapValue && f.mapValue.fields) || {});

// Token de Google a partir de la cuenta de servicio (JWT firmado con RS256)
let cache = { t: '', exp: 0 };
async function googleToken(env) {
  if (cache.t && Date.now() < cache.exp) return cache.t;
  const sa = JSON.parse(env.FIREBASE_SA);
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging'
  });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64u(new Uint8Array(sig));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  }).then(r => r.json());
  if (!r.access_token) throw new Error('No se pudo obtener el token de Google');
  cache = { t: r.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return r.access_token;
}
function b64u(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
