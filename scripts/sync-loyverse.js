// Sincroniza los precios y fotos de catalog/menu-catalog.json con Loyverse y
// escribe el resultado en docs/data/menu-data.json (el archivo que lee index.html).
//
// El catálogo (nombres, categorías, descripciones, tags, modificadores) es la fuente
// de verdad editada a mano. Este script SOLO actualiza `price` (de cada item y size)
// e `image`, buscando el producto correspondiente en Loyverse — primero por
// `loyverseItemId` si el item lo tiene fijado (estable, no se rompe si Loyverse
// renombra el producto), si no por nombre (frágil ante cambios de nombre).
//
// También escribe catalog/loyverse-snapshot.json: un espejo legible de TODO el
// catálogo real de Loyverse (id, nombre, categoría, variantes) para diagnosticar
// emparejamientos fallidos y obtener los IDs reales que fijar como `loyverseItemId`.
//
// Requiere Node 18+ (usa fetch nativo). No usa dependencias externas.
//
// Variables de entorno:
//   LOYVERSE_TOKEN   (obligatoria) Personal Access Token de Loyverse.
//   LOYVERSE_STORE_ID (opcional) Si tu cuenta tiene varias tiendas y los precios
//                      difieren entre ellas, indica el store_id a usar. Si no se
//                      especifica, se usa el default_price del producto.

const fs = require('fs');
const path = require('path');

const CATALOG_PATH = path.join(__dirname, '..', 'catalog', 'menu-catalog.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'docs', 'data', 'menu-data.json');
const SNAPSHOT_PATH = path.join(__dirname, '..', 'catalog', 'loyverse-snapshot.json');
const UNAVAILABLE_PATH = path.join(__dirname, '..', 'catalog', 'unavailable-items.json');
const LOYVERSE_API = 'https://api.loyverse.com/v1.0';

// Lee catalog/unavailable-items.json (lista de ids marcados "agotado" desde
// docs/admin.html) y la fusiona en la salida. Es la fuente durable: el panel
// de administración también actualiza docs/data/menu-data.json directamente
// para que el cambio se vea al instante, pero si no tocara este archivo la
// próxima sincronización de Loyverse borraría el estado "agotado" al
// regenerar todo desde catalog/menu-catalog.json.
function readUnavailableIds() {
  try {
    const raw = JSON.parse(fs.readFileSync(UNAVAILABLE_PATH, 'utf8'));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function normalize(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos (marcas diacríticas combinantes)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchAllPages(token, endpoint, listKey) {
  const results = [];
  let cursor = null;
  do {
    const url = new URL(LOYVERSE_API + endpoint);
    url.searchParams.set('limit', '250');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Loyverse API respondió ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    results.push(...(json[listKey] || []));
    cursor = json.cursor || null;
  } while (cursor);
  return results;
}

async function fetchAllLoyverseItems(token) {
  return fetchAllPages(token, '/items', 'items');
}

async function fetchAllLoyverseCategories(token) {
  return fetchAllPages(token, '/categories', 'categories');
}

// Guarda un "espejo" legible del catálogo real de Loyverse (IDs, nombres,
// categorías, variantes) en catalog/ (privado, no se publica). Sirve para
// diagnosticar de una vez por qué un producto no se emparejó, sin tener que
// copiar/pegar nombres uno por uno — y para obtener los IDs reales que se
// pueden fijar como `loyverseItemId` en menu-catalog.json (emparejamiento
// estable que no se rompe si el producto se renombra en Loyverse).
function writeSnapshot(loyverseItems, loyverseCategories) {
  const categoryNameById = new Map(loyverseCategories.map(c => [c.id, c.name]));
  const snapshot = loyverseItems
    .filter(it => !it.deleted_at)
    .map(it => ({
      id: it.id,
      item_name: it.item_name,
      category: categoryNameById.get(it.category_id) || null,
      image_url: it.image_url || null,
      variants: (it.variants || [])
        .filter(v => !v.deleted_at)
        .map(v => ({
          variant_id: v.variant_id,
          sku: v.sku || null,
          option1_value: v.option1_value || null,
          option2_value: v.option2_value || null,
          option3_value: v.option3_value || null,
          default_price: v.default_price,
        })),
    }))
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.item_name.localeCompare(b.item_name));
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
}

function variantPrice(variant, storeId) {
  if (storeId && Array.isArray(variant.stores)) {
    const store = variant.stores.find(s => s.store_id === storeId);
    if (store && typeof store.price === 'number') return store.price;
  }
  if (typeof variant.default_price === 'number') return variant.default_price;
  if (Array.isArray(variant.stores) && variant.stores.length && typeof variant.stores[0].price === 'number') {
    return variant.stores[0].price;
  }
  return null;
}

function buildLoyverseIndex(loyverseItems) {
  const byName = new Map();
  for (const it of loyverseItems) {
    if (it.deleted_at) continue;
    const key = normalize(it.item_name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(it);
  }
  return byName;
}

function matchLoyverseItems(catalogItem, byId, byName) {
  // Emparejamiento por ID es preferido: es estable aunque el producto se
  // renombre en Loyverse. Se fija a mano en menu-catalog.json una vez
  // identificado el ID correcto (ver catalog/loyverse-snapshot.json).
  if (catalogItem.loyverseItemId) {
    const byIdMatch = byId.get(catalogItem.loyverseItemId);
    return byIdMatch ? [byIdMatch] : null;
  }
  const explicitName = catalogItem.loyverseItemName || catalogItem.name;
  const key = normalize(explicitName);
  const matches = byName.get(key);
  if (!matches || matches.length === 0) return null;
  return matches; // puede haber más de una coincidencia (ver combineVariants)
}

// Junta las variantes activas de TODOS los productos de Loyverse que compartan
// el mismo nombre. Cubre el caso real de cafeterías que, en vez de crear un solo
// producto "Té X" con variantes Frío/Caliente, crean dos productos separados
// llamados igual ("Té X" y "Té X"), uno por tamaño — cada uno con 1 sola variante.
function combineVariants(candidates) {
  const all = [];
  for (const item of candidates) {
    for (const v of (item.variants || [])) {
      if (!v.deleted_at) all.push(v);
    }
  }
  return all;
}

function firstImageUrl(candidates) {
  for (const item of candidates) {
    if (item.image_url) return item.image_url;
  }
  return null;
}

// Resuelve el precio (y el producto de Loyverse) de UNA talla que tiene su
// propio `loyverseItemId` fijado — cubre el caso real de cafeterías donde cada
// talla es un producto de Loyverse completamente distinto (ej. "Agua Pequeña",
// "Agua Mediana", "Agua Grande" en vez de variantes de un mismo "Agua").
function resolveSizeById(sz, byId, storeId, itemName, warnings) {
  const loyverseItem = byId.get(sz.loyverseItemId);
  if (!loyverseItem) {
    warnings.push(`"${itemName}" → tamaño "${sz.label}": el loyverseItemId fijado ya no existe en Loyverse.`);
    return null;
  }
  const variants = (loyverseItem.variants || []).filter(v => !v.deleted_at);
  if (variants.length === 0) {
    warnings.push(`"${itemName}" → tamaño "${sz.label}": el producto existe en Loyverse pero no tiene variantes activas.`);
    return null;
  }
  const price = variantPrice(variants[0], storeId);
  if (price == null) {
    warnings.push(`"${itemName}" → tamaño "${sz.label}": no se encontró un precio válido en Loyverse.`);
    return null;
  }
  return { price, imageUrl: loyverseItem.image_url || null };
}

function syncSizedItem(catalogItem, candidates, byId, storeId, warnings) {
  const updated = { ...catalogItem };

  // Pool de variantes por nombre (fallback) solo para las tallas que NO
  // tengan loyverseItemId propio — se calcula una sola vez, y solo si hace
  // falta (si todas las tallas ya tienen su propio ID, ni se toca, para no
  // ensuciar el log con avisos de "ambiguo"/"combinado" que no aplican).
  let namedVariants = null;
  let namedVariantsComputed = false;
  const getNamedVariants = () => {
    if (namedVariantsComputed) return namedVariants;
    namedVariantsComputed = true;
    if (!candidates) return null;
    namedVariants = combineVariants(candidates);
    if (candidates.length > 1 && namedVariants.length !== catalogItem.sizes.length) {
      warnings.push(`⚠ Nombre ambiguo en Loyverse para "${catalogItem.name}" (${candidates.length} coincidencias), usando la primera.`);
      namedVariants = (candidates[0].variants || []).filter(v => !v.deleted_at);
    } else if (candidates.length > 1) {
      warnings.push(`"${catalogItem.name}": Loyverse tiene ${candidates.length} productos separados con el mismo nombre (uno por tamaño); se combinaron sus variantes.`);
    }
    return namedVariants;
  };

  let anyResolved = false;
  let imageUrl = firstImageUrl(candidates || []);

  const newSizes = catalogItem.sizes.map((sz, i) => {
    if (sz.loyverseItemId) {
      const resolved = resolveSizeById(sz, byId, storeId, catalogItem.name, warnings);
      if (!resolved) return sz;
      anyResolved = true;
      if (!imageUrl && resolved.imageUrl) imageUrl = resolved.imageUrl;
      return { ...sz, price: resolved.price };
    }

    const namedVariants = getNamedVariants();
    const variantsByLabel = new Map();
    if (namedVariants) {
      for (const v of namedVariants) {
        const label = v.option1_value || v.option2_value || v.option3_value || '';
        if (label) variantsByLabel.set(normalize(label), v);
      }
    }

    if (!namedVariants) {
      warnings.push(`"${catalogItem.name}" → tamaño "${sz.label}": no se encontró producto ni talla correspondiente en Loyverse.`);
      return sz;
    }
    if (namedVariants.length === 1 && catalogItem.sizes.length > 1) {
      warnings.push(`"${catalogItem.name}": tiene ${catalogItem.sizes.length} tamaños en el menú pero Loyverse solo tiene 1 variante. No se actualizó "${sz.label}".`);
      return sz;
    }
    const explicitLabel = sz.loyverseVariantValue || sz.label;
    let variant = variantsByLabel.get(normalize(explicitLabel));
    let positional = false;
    if (!variant && namedVariants.length === catalogItem.sizes.length) {
      variant = namedVariants[i];
      positional = true;
    }
    if (!variant) {
      warnings.push(`"${catalogItem.name}" → tamaño "${sz.label}": no se encontró variante correspondiente en Loyverse.`);
      return sz;
    }
    const price = variantPrice(variant, storeId);
    if (price == null) {
      warnings.push(`"${catalogItem.name}" → tamaño "${sz.label}": variante encontrada en Loyverse pero sin precio válido.`);
      return sz;
    }
    if (positional) {
      warnings.push(`"${catalogItem.name}" → tamaño "${sz.label}": emparejado por posición (no por nombre), verifica que el orden coincida con Loyverse.`);
    }
    anyResolved = true;
    return { ...sz, price };
  });

  updated.sizes = newSizes;
  if (imageUrl && updated.image !== imageUrl) updated.image = imageUrl;
  return { updated, anyResolved };
}

function syncFlatItem(catalogItem, candidates, storeId, warnings) {
  let updated = { ...catalogItem };

  if (candidates.length > 1) {
    warnings.push(`⚠ Nombre ambiguo en Loyverse para "${catalogItem.name}" (${candidates.length} coincidencias), usando la primera.`);
  }
  const variants = (candidates[0].variants || []).filter(v => !v.deleted_at);
  if (variants.length === 0) {
    warnings.push(`"${catalogItem.name}": el producto existe en Loyverse pero no tiene variantes activas.`);
  } else {
    if (variants.length > 1) {
      warnings.push(`"${catalogItem.name}": tiene un solo precio en el menú pero Loyverse tiene ${variants.length} variantes. Se usó la primera variante.`);
    }
    const price = variantPrice(variants[0], storeId);
    if (price == null) {
      warnings.push(`"${catalogItem.name}": no se encontró un precio válido en Loyverse.`);
    } else {
      updated.price = price;
    }
  }

  const imageUrl = firstImageUrl(candidates);
  if (imageUrl && updated.image !== imageUrl) updated.image = imageUrl;
  return updated;
}

async function main() {
  const token = process.env.LOYVERSE_TOKEN;
  if (!token) {
    console.error('Falta la variable de entorno LOYVERSE_TOKEN.');
    process.exit(1);
  }
  const storeId = process.env.LOYVERSE_STORE_ID || null;

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

  console.log('Consultando catálogo de Loyverse…');
  const [loyverseItems, loyverseCategories] = await Promise.all([
    fetchAllLoyverseItems(token),
    fetchAllLoyverseCategories(token),
  ]);
  console.log(`Loyverse devolvió ${loyverseItems.length} productos en ${loyverseCategories.length} categorías.`);

  writeSnapshot(loyverseItems, loyverseCategories);

  const byId = new Map(loyverseItems.filter(it => !it.deleted_at).map(it => [it.id, it]));
  const byName = buildLoyverseIndex(loyverseItems);

  const warnings = [];
  let matched = 0;
  let unmatched = 0;

  const newItems = catalog.ITEMS.map(item => {
    const candidates = matchLoyverseItems(item, byId, byName);

    if (item.sizes && item.sizes.length) {
      const hasSizeIds = item.sizes.some(sz => sz.loyverseItemId);
      if (!candidates && !hasSizeIds) {
        unmatched++;
        warnings.push(`"${item.name}": no se encontró ningún producto con ese nombre en Loyverse. Se mantiene el último precio conocido.`);
        return item;
      }
      const { updated, anyResolved } = syncSizedItem(item, candidates, byId, storeId, warnings);
      if (anyResolved) matched++; else unmatched++;
      return updated;
    }

    if (!candidates) {
      unmatched++;
      warnings.push(`"${item.name}": no se encontró ningún producto con ese nombre en Loyverse. Se mantiene el último precio conocido.`);
      return item;
    }
    matched++;
    return syncFlatItem(item, candidates, storeId, warnings);
  });

  const unavailableIds = readUnavailableIds();
  const itemsWithAvailability = newItems.map(item =>
    unavailableIds.has(item.id) ? { ...item, available: false } : item
  );

  const output = {
    CATEGORIES: catalog.CATEGORIES,
    MODIFIER_GROUPS: catalog.MODIFIER_GROUPS,
    ITEMS: itemsWithAvailability,
    _syncedAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');

  console.log(`\nSincronización completa: ${matched} productos emparejados, ${unmatched} sin emparejar.`);
  if (warnings.length) {
    console.log(`\n${warnings.length} advertencias:`);
    for (const w of warnings) console.log(' - ' + w);
  }
}

main().catch(err => {
  console.error('Error en la sincronización:', err.message);
  process.exit(1);
});
