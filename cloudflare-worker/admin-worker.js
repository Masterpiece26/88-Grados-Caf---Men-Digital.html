// Worker de Cloudflare para docs/admin.html: recibe la contraseña simple del
// panel, y si es correcta, usa un token de GitHub (guardado como secret de
// este Worker, nunca visible en el navegador) para marcar/desmarcar un
// producto como "agotado" directamente en el repositorio.
//
// Variables de entorno requeridas (Settings → Variables and Secrets del Worker):
//   ADMIN_PASSWORD   Contraseña simple que usará el personal en docs/admin.html.
//   GITHUB_TOKEN     Personal Access Token de GitHub (fine-grained, con permiso
//                     "Contents: Read and write" SOLO sobre este repositorio).
//   GITHUB_REPO      "usuario/nombre-del-repo", ej. "Masterpiece26/88-Grados-Caf---Men-Digital.html"
//   ALLOWED_ORIGIN   Origen permitido para CORS, ej. "https://masterpiece26.github.io"

const UNAVAILABLE_PATH = 'catalog/unavailable-items.json';
const SETTINGS_PATH = 'catalog/settings.json';
const MENU_DATA_PATH = 'docs/data/menu-data.json';
const BRANCH = 'main';

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

    if (!env.ADMIN_PASSWORD || !safeEqual(body.password, env.ADMIN_PASSWORD)) {
      return json({ error: 'Contraseña incorrecta' }, 401, env);
    }

    if (body.action === 'verify') {
      return json({ ok: true }, 200, env);
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
