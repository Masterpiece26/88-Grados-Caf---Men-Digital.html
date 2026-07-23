// Worker de Cloudflare para docs/index.html y docs/admin.html.
//
// Dos grupos de acciones:
// 1) Administración (requieren ADMIN_PASSWORD): verify, toggle, updateSettings, stats.
//    Usan un token de GitHub (secret de este Worker, nunca visible en el navegador)
//    para leer/escribir archivos del repositorio.
// 2) Registro de uso (públicas, sin contraseña — las llama docs/index.html en cada
//    visita/clic de un cliente cualquiera): track. Guarda un evento en D1.
//
// Variables de entorno requeridas (Settings → Variables and Secrets del Worker):
//   ADMIN_PASSWORD   Contraseña simple que usará el personal en docs/admin.html.
//   GITHUB_TOKEN     Personal Access Token de GitHub (fine-grained, con permiso
//                     "Contents: Read and write" SOLO sobre este repositorio).
//   GITHUB_REPO      "usuario/nombre-del-repo", ej. "Masterpiece26/88-Grados-Caf---Men-Digital.html"
//   ALLOWED_ORIGIN   Origen permitido para CORS, ej. "https://masterpiece26.github.io"
// Binding requerido (Settings → Bindings → Add → D1 database):
//   DB               Base de datos D1 con la tabla `events` (ver README, Paso 7).

const UNAVAILABLE_PATH = 'catalog/unavailable-items.json';
const SETTINGS_PATH = 'catalog/settings.json';
const MENU_DATA_PATH = 'docs/data/menu-data.json';
const BRANCH = 'main';

const TRACK_TYPES = new Set(['page_view', 'item_view', 'search', 'add_to_cart', 'order_sent']);

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

// Comparación en tiempo constante para no filtrar la contraseña por timing.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': '88-grados-admin-worker',
  };
}

async function getFile(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}`);
  const data = await res.json();
  const content = decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))));
  return { content, sha: data.sha };
}

async function putFile(env, path, content, sha, message) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    sha,
    branch: BRANCH,
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub PUT ${path} → ${res.status}: ${errText.slice(0, 200)}`);
  }
}

async function toggleAvailability(env, itemId, available) {
  // 1) Fuente durable: catalog/unavailable-items.json — la próxima sincronización
  //    con Loyverse la respeta y no pierde el estado "agotado".
  const list = await getFile(env, UNAVAILABLE_PATH);
  let ids = [];
  try { ids = JSON.parse(list.content); } catch { ids = []; }
  if (!Array.isArray(ids)) ids = [];

  const has = ids.includes(itemId);
  if (available && has) {
    ids = ids.filter(id => id !== itemId);
  } else if (!available && !has) {
    ids.push(itemId);
  } else {
    // Ya estaba en el estado pedido — nada que guardar aquí, pero igual
    // seguimos para asegurar que menu-data.json quede consistente.
  }
  await putFile(
    env, UNAVAILABLE_PATH,
    JSON.stringify(ids, null, 2) + '\n',
    list.sha,
    `Panel: ${available ? 'marcar disponible' : 'marcar agotado'} "${itemId}"`
  );

  // 2) Reflejo inmediato: parcha docs/data/menu-data.json directamente para
  //    que el cambio se vea sin esperar la próxima sincronización (hasta 15 min).
  const menu = await getFile(env, MENU_DATA_PATH);
  let menuData;
  try { menuData = JSON.parse(menu.content); } catch (e) {
    throw new Error('menu-data.json no es JSON válido: ' + e.message);
  }
  const item = (menuData.ITEMS || []).find(it => it.id === itemId);
  if (!item) throw new Error(`Item "${itemId}" no existe en menu-data.json`);
  if (available) delete item.available;
  else item.available = false;

  await putFile(
    env, MENU_DATA_PATH,
    JSON.stringify(menuData, null, 2) + '\n',
    menu.sha,
    `Panel: ${available ? 'marcar disponible' : 'marcar agotado'} "${itemId}" (reflejo inmediato)`
  );
}

async function updateWhatsappNumber(env, whatsappNumber) {
  // 1) Fuente durable: catalog/settings.json.
  const settingsFile = await getFile(env, SETTINGS_PATH);
  let settings = {};
  try { settings = JSON.parse(settingsFile.content); } catch { settings = {}; }
  if (!settings || typeof settings !== 'object') settings = {};
  settings.whatsappNumber = whatsappNumber;

  await putFile(
    env, SETTINGS_PATH,
    JSON.stringify(settings, null, 2) + '\n',
    settingsFile.sha,
    'Panel: actualizar número de WhatsApp'
  );

  // 2) Reflejo inmediato en docs/data/menu-data.json.
  const menu = await getFile(env, MENU_DATA_PATH);
  let menuData;
  try { menuData = JSON.parse(menu.content); } catch (e) {
    throw new Error('menu-data.json no es JSON válido: ' + e.message);
  }
  menuData.whatsappNumber = whatsappNumber;

  await putFile(
    env, MENU_DATA_PATH,
    JSON.stringify(menuData, null, 2) + '\n',
    menu.sha,
    'Panel: actualizar número de WhatsApp (reflejo inmediato)'
  );
}

async function trackEvent(env, { type, itemId, query, mesa }) {
  if (!env.DB) throw new Error('Falta el binding D1 "DB" en el Worker (ver README, Paso 7).');
  const ts = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'INSERT INTO events (ts, type, item_id, query, mesa) VALUES (?, ?, ?, ?, ?)'
  ).bind(ts, type, itemId || null, query || null, mesa || null).run();
}

async function getStats(env, from, to) {
  if (!env.DB) throw new Error('Falta el binding D1 "DB" en el Worker (ver README, Paso 7).');

  const totalsRes = await env.DB.prepare(
    'SELECT type, COUNT(*) as count FROM events WHERE ts BETWEEN ? AND ? GROUP BY type'
  ).bind(from, to).all();
  const totals = {};
  for (const row of totalsRes.results) totals[row.type] = row.count;

  const topBy = async (type, col = 'item_id') => {
    const res = await env.DB.prepare(
      `SELECT ${col} as key, COUNT(*) as count FROM events WHERE type = ? AND ts BETWEEN ? AND ? AND ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY count DESC LIMIT 10`
    ).bind(type, from, to).all();
    return res.results;
  };

  const dailyRes = await env.DB.prepare(
    "SELECT date(ts, 'unixepoch') as day, COUNT(*) as count FROM events WHERE type = 'page_view' AND ts BETWEEN ? AND ? GROUP BY day ORDER BY day"
  ).bind(from, to).all();

  return {
    totals: {
      page_view: totals.page_view || 0,
      item_view: totals.item_view || 0,
      search: totals.search || 0,
      add_to_cart: totals.add_to_cart || 0,
      order_sent: totals.order_sent || 0,
    },
    topViewed: await topBy('item_view'),
    topAddedToCart: await topBy('add_to_cart'),
    topSearches: await topBy('search', 'query'),
    dailyViews: dailyRes.results,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Método no permitido' }, 405, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'JSON inválido' }, 400, env);
    }

    // 'track' es pública (la llama el menú de cualquier cliente) — no pide contraseña.
    if (body.action === 'track') {
      if (!TRACK_TYPES.has(body.type)) {
        return json({ error: 'Tipo de evento inválido' }, 400, env);
      }
      try {
        await trackEvent(env, body);
        return json({ ok: true }, 200, env);
      } catch (err) {
        return json({ error: err.message }, 500, env);
      }
    }

    if (!env.ADMIN_PASSWORD || !safeEqual(body.password, env.ADMIN_PASSWORD)) {
      return json({ error: 'Contraseña incorrecta' }, 401, env);
    }

    if (body.action === 'verify') {
      return json({ ok: true }, 200, env);
    }

    if (body.action === 'stats') {
      const from = Number(body.from);
      const to = Number(body.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return json({ error: 'Faltan from/to (timestamps en segundos)' }, 400, env);
      }
      try {
        const stats = await getStats(env, from, to);
        return json({ ok: true, stats }, 200, env);
      } catch (err) {
        return json({ error: err.message }, 500, env);
      }
    }

    if (body.action === 'toggle') {
      if (!body.itemId || typeof body.available !== 'boolean') {
        return json({ error: 'Faltan itemId o available' }, 400, env);
      }
      try {
        await toggleAvailability(env, body.itemId, body.available);
        return json({ ok: true }, 200, env);
      } catch (err) {
        return json({ error: err.message }, 500, env);
      }
    }

    if (body.action === 'updateSettings') {
      const digits = String(body.whatsappNumber || '').replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) {
        return json({ error: 'Número de WhatsApp inválido (debe tener entre 10 y 15 dígitos, con código de país).' }, 400, env);
      }
      try {
        await updateWhatsappNumber(env, digits);
        return json({ ok: true }, 200, env);
      } catch (err) {
        return json({ error: err.message }, 500, env);
      }
    }

    return json({ error: 'Acción desconocida' }, 400, env);
  },
};
