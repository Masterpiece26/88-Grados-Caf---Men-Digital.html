// Sincroniza los precios y fotos de data/menu-catalog.json con Loyverse y escribe
// el resultado en data/menu-data.json (el archivo que lee index.html).
//
// El catálogo (nombres, categorías, descripciones, tags, modificadores) es la fuente
// de verdad editada a mano. Este script SOLO actualiza `price` (de cada item y size)
// e `image`, buscando el producto correspondiente en Loyverse por nombre.
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
const LOYVERSE_API = 'https://api.loyverse.com/v1.0';

function normalize(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita acentos (marcas diacríticas combinantes)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchAllLoyverseItems(token) {
  const items = [];
  let cursor = null;
  do {
    const url = new URL(LOYVERSE_API + '/items');
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
    items.push(...(json.items || []));
    cursor = json.cursor || null;
  } while (cursor);
  return items;
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

function matchLoyverseItem(catalogItem, byName) {
  const explicitName = catalogItem.loyverseItemName || catalogItem.name;
  const key = normalize(explicitName);
  const matches = byName.get(key);
  if (!matches || matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(`⚠ Nombre ambiguo en Loyverse para "${catalogItem.name}" (${matches.length} coincidencias), usando la primera.`);
  }
  return matches[0];
}

function syncItemPrice(catalogItem, loyverseItem, storeId, warnings) {
  const variants = (loyverseItem.variants || []).filter(v => !v.deleted_at);
  if (variants.length === 0) {
    warnings.push(`"${catalogItem.name}": el producto existe en Loyverse pero no tiene variantes activas.`);
    return catalogItem;
  }

  const updated = { ...catalogItem };

  if (catalogItem.sizes && catalogItem.sizes.length) {
    if (variants.length === 1) {
      warnings.push(`"${catalogItem.name}": tiene ${catalogItem.sizes.length} tamaños en el menú pero Loyverse solo tiene 1 variante. No se actualizaron los precios.`);
      return catalogItem;
    }
    const variantsByLabel = new Map();
    for (const v of variants) {
      const label = v.option1_value || v.option2_value || v.option3_value || '';
      if (label) variantsByLabel.set(normalize(label), v);
    }
    const newSizes = catalogItem.sizes.map((sz, i) => {
      const explicitLabel = sz.loyverseVariantValue || sz.label;
      let variant = variantsByLabel.get(normalize(explicitLabel));
      let positional = false;
      if (!variant && variants.length === catalogItem.sizes.length) {
        variant = variants[i];
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
      return { ...sz, price };
    });
    updated.sizes = newSizes;
    return updated;
  }

  if (variants.length > 1) {
    warnings.push(`"${catalogItem.name}": tiene un solo precio en el menú pero Loyverse tiene ${variants.length} variantes. Se usó la primera variante.`);
  }
  const price = variantPrice(variants[0], storeId);
  if (price == null) {
    warnings.push(`"${catalogItem.name}": no se encontró un precio válido en Loyverse.`);
    return catalogItem;
  }
  updated.price = price;
  return updated;
}

function syncItemImage(catalogItem, loyverseItem) {
  // image_url es un campo del producto en Loyverse (no de la variante), se sube
  // desde el Back Office de Loyverse (Productos → [producto] → foto).
  if (!loyverseItem.image_url) return catalogItem;
  if (catalogItem.image === loyverseItem.image_url) return catalogItem;
  return { ...catalogItem, image: loyverseItem.image_url };
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
  const loyverseItems = await fetchAllLoyverseItems(token);
  console.log(`Loyverse devolvió ${loyverseItems.length} productos.`);

  const byName = buildLoyverseIndex(loyverseItems);

  const warnings = [];
  let matched = 0;
  let unmatched = 0;

  const newItems = catalog.ITEMS.map(item => {
    const loyverseItem = matchLoyverseItem(item, byName);
    if (!loyverseItem) {
      unmatched++;
      warnings.push(`"${item.name}": no se encontró ningún producto con ese nombre en Loyverse. Se mantiene el último precio conocido.`);
      return item;
    }
    matched++;
    const withPrice = syncItemPrice(item, loyverseItem, storeId, warnings);
    return syncItemImage(withPrice, loyverseItem);
  });

  const output = {
    CATEGORIES: catalog.CATEGORIES,
    MODIFIER_GROUPS: catalog.MODIFIER_GROUPS,
    ITEMS: newItems,
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
