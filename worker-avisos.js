// VillorvinAdventure — Worker de avisos con la app cerrada (Cloudflare) · v3.6
// Nombre del Worker: villorvinadventure-push  →  https://villorvinadventure-push.pedrosaborrego.workers.dev
// Secretos (Settings → Variables and Secrets), los mismos de siempre:
//   FIREBASE_SA  = el contenido COMPLETO del archivo JSON de la cuenta de servicio de Firebase
//   FIREBASE_KEY = la "Browser key" (apiKey) de Firebase: AIzaSy...
//   ORG_EMAILS   = correos de la organización que pueden mandar avisos desde la consola, separados por comas
//                  (se guardan como secreto para que no queden escritos en el código público)
// Disparador programado (Settings → Triggers → Cron Triggers):  */5 * * * *
// Comprobación (no enseña los secretos): abre en el navegador  …workers.dev/?diag
//
// Qué avisos manda (sustituye a las funciones de Firebase, que necesitan el plan Blaze):
//   sos    → SOS de un ciclista a la organización del club (administradores y capitanes)
//   new    → salida nueva del club a los miembros del club (o de su grupeta)
//   chg    → cambio de día, hora o lugar a los apuntados
//   can    → salida cancelada a los apuntados
//   alert  → avisos en ruta (pinchazo, esperad, ayuda, caída, perdido…) a los apuntados
//   test   → prueba: el ciclista se manda un aviso a sí mismo a los 10 segundos (1 por minuto)
//   org    → desde la consola (solo cuentas de la organización): novedad, próximo viaje, publicidad,
//            aviso general y respuesta a una consulta. La publicidad solo llega a quien la acepta en Perfil.
//   ack    → el móvil confirma que le ha llegado un aviso de la organización (firmado: nadie puede inventarlo)
//            La consola ve en va_push/{aviso}: enviados (sent), recibidos (recv) y vistos (seen, lo marca la app)
//   cron   → recordatorio la víspera (desde las 20:00) y 1 hora antes, a los apuntados
// Seguridad: cada aviso se comprueba en la base de datos (quién lo pide, que es suyo y que es reciente)
// y no se puede repetir para llenar de avisos los móviles del club.
// Límite del plan gratis de Cloudflare: 50 conexiones por llamada. Si hay muchos móviles,
// el aviso se manda por tandas (la app pide la siguiente tanda; los recordatorios siguen en el próximo turno).

const PROJECT = 'villorvinadventure-38c74';
// v3.1: también la dirección de GitHub Pages (mientras no esté activo el dominio propio)
const ORIGINS = ['https://app.villorvinadventure.com', 'https://obracontrol-tech.github.io'];
const TZ = 'Europe/Madrid';
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const FS = `https://firestore.googleapis.com/v1/${DOCS}`;
const BUDGET = 46;            // conexiones que usamos de las 50 del plan gratis (dejamos margen)
const OPEN = 'pro.html';      // página que abre el aviso

const ALERTS = {
  flat: 'PINCHAZO', wait: 'ESPERAD', help: 'NECESITA AYUDA', ok: 'SOLUCIONADO, SEGUIMOS', lost: 'SE HA PERDIDO',
  mech: 'AVERÍA MECÁNICA', back: 'SE QUEDA ATRÁS', fall: 'ACCIDENTE', boss: 'AVISO DEL JEFE DE RUTA',
  late: 'VA PARA ALLÁ', join: 'YA ESTÁ CON VOSOTROS'
};
const URGENT = ['help', 'fall', 'lost'];
// Cuentas de Google de la organización: secreto ORG_EMAILS de Cloudflare (las mismas que isVAOrg en las reglas de Firebase)
const orgEmails = env => String(env.ORG_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);

export default {
  async fetch(req, env, ctxCf) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method === 'GET' && new URL(req.url).searchParams.has('diag')) return out(await diag(env));
    if (req.method !== 'POST') return out({ ok: true, info: 'villorvinadventure-push v3.6 activo' });
    const C = ctx(env);
    try {
      const b = await req.json();
      if (b && b.t === 'ack') return out(await ack(C, b));
      if (!b || typeof b.idToken !== 'string') return out({ error: 'datos' }, 400);
      const user = await whoIs(C, b.idToken);
      const uid = user && user.localId;
      if (!uid) return out({ error: 'auth' }, 401);
      const t = b.t || 'sos';
      if (t === 'sos') return out(await sos(C, uid, b));
      if (t === 'test') return out(await selfTest(C, uid, ctxCf));
      if (t === 'org') return out(await orgEvent(C, user, b, Math.max(0, Math.min(20000, parseInt(b.from, 10) || 0))));
      if (!/^[A-Za-z0-9]{20}$/.test(b.ride || '')) return out({ error: 'datos' }, 400);
      const from = Math.max(0, Math.min(5000, parseInt(b.from, 10) || 0));
      if (t === 'new' || t === 'chg' || t === 'can') return out(await rideEvent(C, uid, t, b.ride, from));
      if (t === 'alert') return out(await alertEvent(C, uid, b.ride, String(b.id || ''), from));
      return out({ error: 'tipo' }, 400);
    } catch (e) {
      return out({ error: String(e && e.message || e) }, (e && e.code >= 400 && e.code < 600) ? e.code : 500);
    }
  },
  // Recordatorios: Cloudflare lo llama cada 5 minutos
  async scheduled(event, env, ctxCf) {
    ctxCf.waitUntil(reminders(ctx(env)).catch(e => console.log('recordatorios', e && e.message)));
  }
};

/* ---------------- Contexto y conexiones contadas ---------------- */
function ctx(env) {
  const C = { env, used: 0, H: null };
  C.f = (url, opt) => { C.used++; return fetch(url, opt); };
  C.left = () => BUDGET - C.used;
  C.auth = async () => { if (!C.H) C.H = { Authorization: 'Bearer ' + await googleToken(C) }; return C.H; };
  C.get = async path => { const r = await C.f(`${FS}/${path}`, { headers: await C.auth() }); return r.ok ? (await r.json()).fields || {} : null; };
  C.patch = async (path, fields, mask) => C.f(`${FS}/${path}?${mask.map(m => 'updateMask.fieldPaths=' + encodeURIComponent(m)).join('&')}`, {
    method: 'PATCH', headers: { ...await C.auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ fields })
  });
  return C;
}
const fail = (msg, code) => { const e = new Error(msg); e.code = code; return e; };

async function whoIs(C, idToken) {
  const r = await C.f(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${C.env.FIREBASE_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  }).then(r => r.json());
  return r.users && r.users[0] || null;
}

/* ---------------- SOS a la organización (como hasta ahora) ---------------- */
async function sos(C, uid, { club, msg }) {
  if (!/^[A-Z0-9]{6}$/.test(club || '') || !/^[A-Za-z0-9]{10,40}$/.test(msg || '')) throw fail('datos', 400);
  const m = await C.get(`groups/${club}/msgs/${msg}`);
  if (!m) throw fail('mensaje', 404);
  const text = sv(m.text), ts = num(m.ts);
  if (sv(m.uid) !== uid) throw fail('autor', 403);
  if (!text.startsWith('🆘 ALERTA')) throw fail('tipo', 400);
  if (Date.now() - ts > 10 * 60 * 1000) throw fail('antiguo', 400);
  if (m.pushed) return { ok: true, repetido: true };
  await C.patch(`groups/${club}/msgs/${msg}`, { pushed: { booleanValue: true } }, ['pushed']);
  const g = await C.get(`groups/${club}`);
  if (!g) throw fail('club', 404);
  if (!keys(g.members).includes(uid)) throw fail('no es del club', 403);
  const org = [...new Set([sv(g.byUid), ...keys(g.admins), ...keys(g.captains)].filter(Boolean))].filter(a => a !== uid);
  const tokens = await tokensOf(C, org);
  if (!tokens.length) return { ok: true, enviados: 0, info: 'la organización no tiene activados los avisos con la app cerrada' };
  const parts = text.split(' · ');
  const kind = (parts[1] || 'AVISO').replace(/^[^A-ZÁÉÍÓÚÑ]+/u, '');
  const name = parts[2] || 'Un ciclista';
  const tel = (text.match(/📞 ([+0-9 ]{9,20})/) || [])[1] || '';
  const body = (tel ? 'Tel. ' + tel.trim() + '. ' : '') + 'Toca para ver dónde está y gestionarlo.';
  const r = await sendAll(C, tokens, 0, { title: 'SOS VillorvinAdventure · ' + name + ': ' + kind, body, url: './', urgent: '1', tag: 'va-sos' });
  return { ok: true, enviados: r.sent, next: r.next };
}

/* ---------------- Desde la consola: novedades, próximos viajes, publicidad, aviso general y respuestas ---------------- */
async function orgEvent(C, user, b, from) {
  if (!user.email || user.emailVerified !== true || !orgEmails(C.env).includes(String(user.email).toLowerCase())) throw fail('solo la organización', 403);
  const col = String(b.col || ''), id = String(b.id || '');
  if (!['va_news', 'va_rutas', 'va_config', 'va_support'].includes(col) || !/^[A-Za-z0-9_-]{1,60}$/.test(id)) throw fail('datos', 400);
  if (col === 'va_config' && id !== 'aviso') throw fail('datos', 400);
  const d = await C.get(`${col}/${id}`);
  if (!d) throw fail('no existe', 404);
  const ver = col === 'va_support' ? num(d.replyAt) : num(d.t);
  if (!ver || Date.now() - ver > 60 * 60 * 1000) throw fail('antiguo: vuelve a guardarlo para avisar', 400);
  const st = mv(mv(d.px).org);
  if (from === 0) { if (num(st.v) === ver) return { ok: true, repetido: true }; }
  else if (num(st.v) !== ver || from !== num(st.n)) throw fail('tanda', 400);

  const kind = col === 'va_news' ? (['trip', 'promo'].includes(sv(d.kind)) ? sv(d.kind) : 'news')
    : col === 'va_rutas' ? 'trip' : col === 'va_config' ? 'aviso' : 'reply';
  if (kind === 'aviso' && !(d.active && d.active.booleanValue === true)) throw fail('el aviso está quitado', 400);
  let to;
  if (kind === 'reply') {
    if (!sv(d.reply)) throw fail('sin respuesta', 400);
    to = [sv(d.uid)];
  } else {
    const gp = sv(d.gp), club = String(b.club || '');
    const g = /^[A-Z0-9]{6}$/.test(club) ? await C.get(`groups/${club}`) : null;
    if (gp) {
      if (!g) throw fail('para avisar a una grupeta, la cuenta de la consola tiene que estar en el club', 400);
      const gm = mv(g.gm);
      to = keys(g.members).filter(u => arr(gm[u]).includes(gp));
    } else to = [...await listIds(C, 'va_members'), ...(g ? keys(g.members) : [])];
  }
  const tokens = await tokensOf(C, to, kind === 'promo');
  const title = sv(d.title), text = sv(kind === 'reply' ? d.reply : kind === 'trip' && col === 'va_rutas' ? d.info : d.text);
  const T = Date.now();
  const msg = {
    news: { title: 'Novedad: ' + title, body: text, url: `./?a=${T}#va=nov` },
    trip: { title: 'Próximo viaje: ' + title, body: (col === 'va_rutas' && sv(d.date) ? fmtDate(sv(d.date)) + '. ' : '') + text, url: `./?a=${T}#va=${col === 'va_rutas' ? 'rutas' : 'nov'}` },
    promo: { title: 'Publicidad · ' + title, body: text.slice(0, 170) + ' (Puedes dejar de recibir ofertas en Perfil.)', url: `./?a=${T}#va=nov` },
    aviso: { title: 'Aviso de VillorvinAdventure', body: text, url: './' },
    reply: { title: 'VillorvinAdventure ha respondido tu consulta', body: text, url: `./?a=${T}#va=sup` }
  }[kind];
  msg.tag = 'va-org-' + id;
  // Recibo: cada móvil lleva la clave del aviso y su firma, para confirmar que le ha llegado
  const key = col + '_' + id + (col === 'va_config' ? '_' + ver : '');
  msg.rec = key;
  const res = await sendAll(C, tokens, from, msg, 2);
  const sentF = Object.fromEntries(res.okUids.map(u => [u, { integerValue: String(T) }]));
  const meta = from === 0 ? { title: { stringValue: kind === 'aviso' ? 'Aviso general' : kind === 'reply' ? 'Respuesta a consulta' : title },
    kind: { stringValue: kind }, t: { integerValue: String(T) }, total: { integerValue: String(new Set(tokens.map(x => x.u)).size) } } : {};
  await C.patch(`va_push/${key}`, { ...meta, sent: { mapValue: { fields: sentF } } },
    [...Object.keys(meta), ...res.okUids.map(u => 'sent.`' + u + '`')]).catch(() => {});
  await C.patch(`${col}/${id}`, { px: { mapValue: { fields: { org: { mapValue: { fields: {
    v: { integerValue: String(ver) }, n: { integerValue: String(res.next) }, t: { integerValue: String(T) }
  } } } } } } }, ['px.org']);
  return { ok: true, enviados: res.sent, total: tokens.length, next: res.next };
}
// Todos los ciclistas registrados (ids de una colección, de 300 en 300)
async function listIds(C, col) {
  const ids = [];
  let pt = '';
  for (let i = 0; i < 20; i++) {
    const r = await C.f(`${FS}/${col}?pageSize=300&mask.fieldPaths=t${pt ? '&pageToken=' + encodeURIComponent(pt) : ''}`, { headers: await C.auth() });
    if (!r.ok) break;
    const j = await r.json();
    for (const d of j.documents || []) ids.push(d.name.split('/').pop());
    if (!j.nextPageToken) break;
    pt = j.nextPageToken;
  }
  return ids;
}

/* ---------------- Prueba: aviso a uno mismo a los 10 segundos (máx. 1 por minuto) ---------------- */
async function selfTest(C, uid, ctxCf) {
  const p = await C.get(`users/${uid}/private/push`);
  if (!p) return { ok: true, total: 0 };
  if (Date.now() - num(p.lastTest) < 60 * 1000) return { ok: true, espera: true, total: keys(p.tokens).length };
  await C.patch(`users/${uid}/private/push`, { lastTest: { integerValue: String(Date.now()) } }, ['lastTest']);
  const tokens = keys(p.tokens).map(t => ({ u: uid, t }));
  if (tokens.length) ctxCf.waitUntil(new Promise(r => setTimeout(r, 10000)).then(() => sendAll(C, tokens.slice(0, 10), 0, {
    title: 'Prueba de VillorvinAdventure', body: '¡Funciona! Te llegarán los avisos de tu club aunque la app esté cerrada.', url: './', urgent: '0', tag: 'va-test'
  })).catch(() => {}));
  return { ok: true, total: tokens.length };
}

/* ---------------- Salida nueva, cambio o cancelación ---------------- */
async function rideEvent(C, uid, t, rideId, from) {
  const r = await C.get(`rides/${rideId}`);
  if (!r) throw fail('salida', 404);
  const club = sv(r.group), owner = sv(r.byUid);
  const people = keys(r.people);
  let g = null;
  if (t === 'new') {
    if (owner !== uid) throw fail('autor', 403);
    if (!club) return { ok: true, enviados: 0, info: 'salida personal: sin avisos' };
    if (Date.now() - tsMillis(r.createdAt) > 30 * 60 * 1000) throw fail('antiguo', 400);
  } else if (owner !== uid) {
    // cambio o cancelación: el organizador, o un administrador / capitán del club
    if (!club) throw fail('autor', 403);
    g = await C.get(`groups/${club}`);
    if (!g || ![sv(g.byUid), ...keys(g.admins), ...keys(g.captains)].includes(uid)) throw fail('autor', 403);
  }
  // Que no se repita: «new» una sola vez; «chg» y «can» como mucho cada 10 minutos
  const st = mv(mv(r.px)[t]);
  const doneT = num(st.t), nextOld = num(st.n);
  if (from === 0) {
    if (t === 'new' && doneT) return { ok: true, repetido: true };
    if (t !== 'new' && Date.now() - doneT < 10 * 60 * 1000) return { ok: true, repetido: true, info: 'espera 10 minutos entre avisos' };
  } else if (from !== nextOld || Date.now() - doneT > 10 * 60 * 1000) throw fail('tanda', 400);

  // Destinatarios
  let to;
  if (t === 'new') {
    g = g || await C.get(`groups/${club}`);
    if (!g) throw fail('club', 404);
    const gp = sv(r.gp);
    const gm = mv(g.gm);
    to = keys(g.members).filter(u => !gp || arr(gm[u]).includes(gp));
  } else to = people;
  to = to.filter(u => u !== uid);
  const tokens = await tokensOf(C, to);

  const title = sv(r.title) || 'Salida en grupo';
  const when = fmtDate(sv(r.date)) + ' a las ' + sv(r.hour);
  const where = sv(r.meet) || sv(r.start);
  const msg = t === 'new'
    ? { title: 'Nueva salida: ' + title, body: when + (where ? ' · ' + where : '') + '. ¿Te apuntas?', tag: 'va-new-' + rideId }
    : t === 'chg'
      ? { title: 'Cambio en la salida: ' + title, body: 'Ahora: ' + when + (where ? ' · ' + where : ''), tag: 'va-chg-' + rideId }
      : { title: 'Salida cancelada: ' + title, body: 'La salida del ' + when + ' se ha cancelado.', tag: 'va-can-' + rideId };
  msg.url = t === 'can' ? './' : `./${OPEN}?a=${Date.now()}#salida=${rideId}`;

  const res = await sendAll(C, tokens, from, msg);
  await C.patch(`rides/${rideId}`, { px: { mapValue: { fields: { [t]: { mapValue: { fields: {
    t: { integerValue: String(from === 0 ? Date.now() : doneT) }, n: { integerValue: String(res.next) }, u: { stringValue: uid }
  } } } } } } }, ['px.' + t]);
  return { ok: true, enviados: res.sent, total: tokens.length, next: res.next };
}

/* ---------------- Avisos en ruta del pelotón ---------------- */
async function alertEvent(C, uid, rideId, alertId, from) {
  if (!/^[A-Za-z0-9_]{10,80}$/.test(alertId)) throw fail('datos', 400);
  const r = await C.get(`rides/${rideId}`);
  if (!r) throw fail('salida', 404);
  const people = keys(r.people);
  if (!people.includes(uid)) throw fail('no apuntado', 403);
  const lv = await C.get(`rides/${rideId}/live/${uid}`);
  const al = lv && mv(lv.alert);
  if (!al || sv(al.id) !== alertId) throw fail('aviso', 404);
  if (Date.now() - num(al.t) > 5 * 60 * 1000) throw fail('antiguo', 400);
  const key = 'a_' + uid;
  const st = mv(mv(r.px)[key]);
  if (sv(st.id) === alertId) {
    if (from === 0 || from !== num(st.n)) return { ok: true, repetido: true };
  } else if (from !== 0) throw fail('tanda', 400);
  else if (Date.now() - num(st.t) < 5 * 1000) return { ok: true, info: 'demasiado seguido' };

  const type = sv(al.type);
  const name = sv(lv.name) || 'Un ciclista';
  const extra = sv(al.text);
  const kind = ALERTS[type] || 'AVISO';
  const urgent = URGENT.includes(type);
  const tokens = await tokensOf(C, people.filter(u => u !== uid));
  const body = (type === 'boss' && extra ? extra : (sv(r.title) || 'Salida en grupo')) + '. Toca para ver dónde está.';
  const res = await sendAll(C, tokens, from, {
    title: name + ': ' + kind, body, url: `./${OPEN}?a=${Date.now()}#salida=${rideId}`,
    urgent: urgent ? '1' : '0', tag: 'va-alert-' + rideId
  });
  await C.patch(`rides/${rideId}`, { px: { mapValue: { fields: { [key]: { mapValue: { fields: {
    id: { stringValue: alertId }, t: { integerValue: String(Date.now()) }, n: { integerValue: String(res.next) }
  } } } } } } }, ['px.' + key]);
  return { ok: true, enviados: res.sent, total: tokens.length, next: res.next };
}

/* ---------------- Recordatorios (cada 5 minutos) ---------------- */
async function reminders(C) {
  const now = localNow();
  const jobs = [];
  // 1 hora antes: salidas de hoy que empiezan dentro de 65 minutos o menos
  for (const d of await ridesOn(C, now.date)) {
    const mins = toMin(sv(d.f.hour)) - now.min;
    if (mins > 0 && mins <= 65 && !doneRem(d.f, 'h1')) jobs.push({ d, k: 'h1', mins });
  }
  // La víspera: desde las 20:00, salidas de mañana
  if (now.min >= 20 * 60) {
    for (const d of await ridesOn(C, now.tomorrow)) {
      if (doneRem(d.f, 'eve')) continue;
      if (Date.now() - tsMillis(d.f.createdAt) < 3 * 3600 * 1000) continue;  // recién creada: ya llegó el aviso de salida nueva
      jobs.push({ d, k: 'eve' });
    }
  }
  for (const j of jobs) {
    if (C.left() < 6) break;                         // lo que falte, en el próximo turno
    const id = j.d.id, f = j.d.f;
    const st = mv(mv(f.px)[j.k]);
    const from = num(st.n);
    const tokens = await tokensOf(C, keys(f.people));
    const title = sv(f.title) || 'Salida en grupo';
    const where = sv(f.meet) || sv(f.start);
    const msg = j.k === 'h1'
      ? { title: 'Dentro de ' + j.mins + ' min: ' + title, body: 'Salida a las ' + sv(f.hour) + (where ? ' desde ' + where : '') + '. ¡No llegues tarde!', tag: 'va-h1-' + id,
          url: `./${OPEN}?a=${Date.now()}#salida=${id}` }
      : { title: 'Mañana: ' + title, body: 'Salida a las ' + sv(f.hour) + (where ? ' desde ' + where : '') + '. Revisa la bici y el tiempo.', tag: 'va-eve-' + id,
          url: `./${OPEN}?a=${Date.now()}#revisar=${id}` };
    const res = await sendAll(C, tokens, from, msg, 2);
    await C.patch(`rides/${id}`, { px: { mapValue: { fields: { [j.k]: { mapValue: { fields: {
      t: { integerValue: String(Date.now()) }, n: { integerValue: String(res.next) }, done: { booleanValue: res.next === 0 }
    } } } } } } }, ['px.' + j.k]);
  }
}
const doneRem = (f, k) => { const s = mv(mv(f.px)[k]); return s.done && s.done.booleanValue === true; };
async function ridesOn(C, date) {
  const r = await C.f(`${FS}:runQuery`, {
    method: 'POST', headers: { ...await C.auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'rides' }], where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'EQUAL', value: { stringValue: date } } }, limit: 100 } })
  });
  if (!r.ok) return [];
  return (await r.json()).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), f: x.document.fields || {} }));
}

/* ---------------- Móviles y envío ---------------- */
// Lee de una vez los avisos activados de todos los ciclistas (una sola conexión por cada 100)
async function tokensOf(C, uids, onlyPromo) {
  const list = [...new Set(uids)].filter(u => /^[A-Za-z0-9]{10,40}$/.test(u));
  const out = [];
  for (let i = 0; i < list.length; i += 100) {
    const r = await C.f(`${FS}:batchGet`, {
      method: 'POST', headers: { ...await C.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents: list.slice(i, i + 100).map(u => `${DOCS}/users/${u}/private/push`) })
    });
    if (!r.ok) continue;
    for (const x of await r.json()) if (x.found) {
      if (onlyPromo && !((x.found.fields || {}).promo || {}).booleanValue) continue;   // publicidad: solo quien la acepta
      const u = x.found.name.split('/').slice(-3)[0];
      for (const t of keys((x.found.fields || {}).tokens)) out.push({ u, t });
    }
  }
  return out.sort((a, b) => (a.u + a.t).localeCompare(b.u + b.t));   // siempre en el mismo orden (para las tandas)
}
// Manda a partir de «from» con las conexiones que queden; devuelve dónde seguir (0 = terminado)
async function sendAll(C, tokens, from, msg, keep = 1) {
  let i = from, sent = 0;
  const okUids = new Set();
  const dead = [];
  const data = { title: String(msg.title).slice(0, 120), body: String(msg.body).slice(0, 240), url: msg.url || './', urgent: msg.urgent || '0', tag: msg.tag || 'villorvin' };
  const H = await C.auth();
  while (i < tokens.length && C.left() > keep) {
    const tk = tokens[i++];
    const dt = msg.rec ? { ...data, p: msg.rec, u: tk.u, s: await sign(C, msg.rec + '|' + tk.u) } : data;
    const r = await C.f(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: tk.t, data: dt, webpush: { headers: { Urgency: 'high', TTL: data.urgent === '1' ? '900' : '3600' } } } })
    });
    if (r.ok) { sent++; okUids.add(tk.u); }
    else if (r.status === 404 || r.status === 400) dead.push(tk);
  }
  // Borra los móviles que ya no existen (app desinstalada), si quedan conexiones
  for (const d of dead) {
    if (C.left() <= keep) break;
    await C.patch(`users/${d.u}/private/push`, {}, ['tokens.`' + d.t.replace(/[`\\]/g, '\\$&') + '`']).catch(() => {});
  }
  return { sent, next: i < tokens.length ? i : 0, okUids: [...okUids] };
}

/* ---------------- Recibos: el móvil confirma que le ha llegado ---------------- */
async function ack(C, b) {
  const p = String(b.p || ''), u = String(b.u || ''), s = String(b.s || '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(p) || !/^[A-Za-z0-9]{10,40}$/.test(u)) throw fail('datos', 400);
  if (s !== await sign(C, p + '|' + u)) throw fail('firma', 403);
  await C.patch(`va_push/${p}`, { recv: { mapValue: { fields: { [u]: { integerValue: String(Date.now()) } } } } }, ['recv.`' + u + '`']);
  return { ok: true };
}
// Firma corta (HMAC) con una clave sacada de la cuenta de servicio: solo el Worker sabe firmar
let signKey = null;
async function sign(C, text) {
  if (!signKey) {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('va-recibos|' + parseSA(C.env).private_key));
    signKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  }
  const sig = await crypto.subtle.sign('HMAC', signKey, new TextEncoder().encode(text));
  return b64u(new Uint8Array(sig)).slice(0, 22);
}

/* ---------------- Utilidades ---------------- */
const sv = f => f ? (f.stringValue ?? f.integerValue ?? f.doubleValue ?? '') : '';
const num = f => Number(sv(f) || 0);
const mv = f => (f && f.mapValue && f.mapValue.fields) || {};
const keys = f => Object.keys(mv(f));
const arr = f => ((f && f.arrayValue && f.arrayValue.values) || []).map(sv);
const tsMillis = f => f && f.timestampValue ? Date.parse(f.timestampValue) : num(f);
const toMin = h => { const m = /^(\d{1,2}):(\d{2})$/.exec(h || ''); return m ? +m[1] * 60 + +m[2] : -1; };
function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); if (!m) return d;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  const dia = new Intl.DateTimeFormat('es-ES', { weekday: 'long', timeZone: 'UTC' }).format(dt);
  return dia + ' ' + (+m[3]) + '/' + (+m[2]);
}
function localNow() {
  const p = o => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...o })
    .formatToParts(new Date(Date.now() + (o && o.add || 0))).map(x => [x.type, x.value]));
  const a = p(), b = p({ add: 86400000 });
  return { date: `${a.year}-${a.month}-${a.day}`, tomorrow: `${b.year}-${b.month}-${b.day}`, min: +a.hour * 60 + +a.minute };
}

// Lee el secreto FIREBASE_SA (el archivo JSON de la cuenta de servicio) y explica qué falla si está mal pegado
function parseSA(env) {
  const s = String(env.FIREBASE_SA || '').trim().replace(/^\uFEFF/, '');
  if (!s) throw fail('Falta el secreto FIREBASE_SA en Cloudflare', 500);
  let o;
  try { o = JSON.parse(s); if (typeof o === 'string') o = JSON.parse(o); }
  catch (e) { throw fail('El secreto FIREBASE_SA está mal pegado (no es el archivo JSON completo): ' + e.message, 500); }
  if (!o || !o.private_key || !o.client_email) throw fail('El secreto FIREBASE_SA no es una cuenta de servicio (falta private_key o client_email)', 500);
  return o;
}
// ?diag → revisa los secretos y la conexión con Firebase, sin enseñarlos
async function diag(env) {
  const r = { worker: 'v3.6' };
  const k = String(env.FIREBASE_KEY || '');
  r.FIREBASE_KEY = !k ? 'FALTA' : k.startsWith('AIza') ? 'ok' : 'MAL: tiene que empezar por AIza';
  const oe = orgEmails(env);
  r.ORG_EMAILS = oe.length ? 'ok (' + oe.length + ' correos)' : 'FALTA';
  let sa = null;
  try { sa = parseSA(env); r.FIREBASE_SA = 'ok'; r.proyecto_de_la_cuenta = sa.project_id; r.proyecto_correcto = sa.project_id === PROJECT; }
  catch (e) { r.FIREBASE_SA = 'ERROR: ' + e.message; }
  if (sa) {
    try {
      const C = ctx(env); await C.auth(); r.permiso_google = 'ok';
      const t = await C.f(`${FS}/va_config/aviso`, { headers: await C.auth() });
      r.base_de_datos = t.ok || t.status === 404 ? 'ok' : 'ERROR ' + t.status + (t.status === 403 ? ' (la cuenta de servicio no es de este proyecto)' : '');
    } catch (e) { r.permiso_google = 'ERROR: ' + (e && e.message || e); }
  }
  r.todo_bien = r.FIREBASE_KEY === 'ok' && oe.length > 0 && r.FIREBASE_SA === 'ok' && r.proyecto_correcto === true && r.permiso_google === 'ok' && r.base_de_datos === 'ok';
  return r;
}

// Token de Google a partir de la cuenta de servicio (JWT firmado con RS256)
let cache = { t: '', exp: 0 };
async function googleToken(C) {
  if (cache.t && Date.now() < cache.exp) return cache.t;
  const sa = parseSA(C.env);
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
  const r = await C.f('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  }).then(r => r.json());
  if (!r.access_token) throw fail('Google no acepta la cuenta de servicio de FIREBASE_SA (' + (r.error_description || r.error || 'sin detalle') + '). Crea una clave nueva en Firebase → Configuración → Cuentas de servicio', 500);
  cache = { t: r.access_token, exp: Date.now() + 50 * 60 * 1000 };
  return r.access_token;
}
function b64u(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
