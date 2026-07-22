# 88° Grados Café — Menú Digital + Sincronización con Loyverse

Menú digital (con carrito y pedido por WhatsApp) cuyos **precios se actualizan automáticamente
desde Loyverse**, sin exponer nunca tu token de API en el navegador.

## Estructura del proyecto

```
docs/               ← ÚNICA carpeta que GitHub Pages sirve como sitio web (docs/index.html)
  index.html            el menú que ven tus clientes
  admin.html             panel para marcar productos agotados (protegido con contraseña)
  data/menu-data.json   precios/fotos actuales, generado automáticamente

catalog/
  menu-catalog.json      la fuente de verdad que tú editas a mano
  unavailable-items.json lista de productos marcados "agotado" desde admin.html
  loyverse-snapshot.json espejo de tu catálogo real de Loyverse (diagnóstico)

scripts/
  sync-loyverse.js   ← trae precios/fotos de Loyverse y actualiza docs/data/menu-data.json
  dev-server.js      ← servidor local para probar antes de subir cambios

tools/
  generar-qrs.html   ← herramienta interna para generar los QR de las mesas

cloudflare-worker/
  admin-worker.js    ← backend gratuito (Cloudflare) que permite a admin.html guardar cambios

.github/workflows/
  sync-loyverse.yml  ← corre la sincronización cada 15 min en GitHub Actions
```

**GitHub Pages solo publica como sitio web lo que hay dentro de `docs/`** — `catalog/`,
`scripts/`, `tools/` y `cloudflare-worker/` no tienen una URL de menú/QR asociada. Aclaración
importante: como el repositorio en sí es público en GitHub, cualquiera que abra
github.com/tu-usuario/tu-repo puede ver esos archivos igual (no hay contenido secreto en
ellos — nombres, precios, scripts). La única pieza que sí necesita protegerse de verdad es
`docs/admin.html`, y esa protección es la contraseña (más el hecho de que sin ella nadie puede
guardar cambios), no la ubicación del archivo.

## Cómo funciona

```
Loyverse (tu POS)
      │  cada 15 min, GitHub Actions llama a la API de Loyverse
      │  usando un token secreto (nunca visible en el navegador)
      ▼
scripts/sync-loyverse.js  →  actualiza docs/data/menu-data.json
      │  si hubo cambios, los sube (commit + push) al repositorio
      ▼
GitHub Pages sirve docs/index.html, que carga docs/data/menu-data.json
      ▼
El cliente ve el menú con los precios actuales al abrir el QR
```

- `catalog/menu-catalog.json` — **la fuente de verdad que tú editas a mano**: nombres, categorías,
  descripciones, tags, tamaños y modificadores. El precio que pongas aquí es solo el valor inicial.
- `docs/data/menu-data.json` — el archivo que realmente lee la página web. Lo genera y sobrescribe
  automáticamente `scripts/sync-loyverse.js` en cada sincronización. **No lo edites a mano**,
  tus cambios se perderían en la siguiente sincronización.
- El emparejamiento entre tu menú y Loyverse es **por nombre del producto** (ignorando acentos
  y mayúsculas). Si un producto en Loyverse no tiene exactamente el mismo nombre que en
  `menu-catalog.json`, no se podrá actualizar su precio automáticamente (ver sección de
  solución de problemas).

## Paso 1 — Crear el repositorio en GitHub

1. Crea una cuenta gratuita en [github.com](https://github.com) si no tienes una.
2. Crea un repositorio nuevo (puede ser público o privado — con privado, GitHub Pages también
   funciona en cuentas gratuitas; de cualquier forma, lo único que queda público es lo que hay
   dentro de `docs/`, que es exactamente tu menú).
3. Sube todos los archivos de esta carpeta al repositorio (arrastrándolos en la interfaz web de
   GitHub, o con `git init`, `git add .`, `git commit`, `git push` si usas la terminal).

## Paso 2 — Agregar tu token de Loyverse como "Secret"

**Nunca pegues el token directamente en ningún archivo del proyecto.** Se guarda como un
"Secret" de GitHub, que solo GitHub Actions puede leer — nunca se envía al navegador del cliente.

1. En tu repositorio: **Settings → Secrets and variables → Actions → New repository secret**.
2. Nombre: `LOYVERSE_TOKEN`. Valor: tu Personal Access Token de Loyverse (Back Office →
   Configuración → Integraciones → API access token).
3. (Opcional) Si tu cuenta de Loyverse tiene varias tiendas con precios distintos entre sí,
   agrega también un secret `LOYVERSE_STORE_ID` con el ID de la tienda cuyo precio quieres usar.
   Si no lo agregas, se usa el precio general (`default_price`) del producto.

## Paso 3 — Activar GitHub Pages

1. **Settings → Pages**.
2. En "Source" elige **Deploy from a branch**.
3. Rama: `main` (o la que uses), carpeta: **`/docs`** (no "/ (root)" — así solo se publica el
   menú, y todo lo demás queda privado).
4. Guarda. GitHub te dará una URL parecida a `https://tu-usuario.github.io/tu-repo/` — esa es
   la URL que abrirá el menú. Puede tardar uno o dos minutos en estar disponible la primera vez.

## Paso 4 — Probar la sincronización manualmente

No hace falta esperar 15 minutos para la primera prueba:

1. Ve a la pestaña **Actions** de tu repositorio.
2. Elige el workflow **"Sincronizar precios con Loyverse"**.
3. Click en **Run workflow**.
4. Revisa el log: te dirá cuántos productos se emparejaron correctamente y cuáles no (con el
   motivo). Si todo salió bien, verás un commit automático actualizando `docs/data/menu-data.json`
   (solo si hubo cambios de precio).

A partir de ahí, el workflow se ejecuta solo cada 15 minutos.

## Paso 5 — Generar un código QR por mesa

Es el mismo sitio para todas las mesas — lo único que cambia es la URL de cada QR, agregando
`?mesa=` con el número (o nombre) de la mesa al final:

```
https://tu-usuario.github.io/tu-repo/?mesa=1
https://tu-usuario.github.io/tu-repo/?mesa=2
https://tu-usuario.github.io/tu-repo/?mesa=3
...
https://tu-usuario.github.io/tu-repo/?mesa=Terraza-2   ← también acepta nombres, no solo números
```

Cuando un cliente entra desde uno de esos enlaces:

- Ve un aviso "📍 Mesa N" debajo del encabezado, para confirmar que está en la mesa correcta.
- Al enviar el pedido por WhatsApp, el mensaje incluye automáticamente la línea `📍 Mesa: N`
  antes del detalle del pedido — así pueden despachar a la mesa correcta sin depender de que
  una mesera esté disponible para preguntar.

### Generar e imprimir todos los QR de una vez

Abre [`tools/generar-qrs.html`](tools/generar-qrs.html) en tu navegador (doble-click al
archivo, no necesita servidor ni internet salvo para generar las imágenes de los QR). Esta
página **no está publicada** — vive solo en tu repositorio (fuera de `docs/`) y en tu
computadora; nadie más tiene acceso a menos que le compartas el archivo directamente.

1. Necesitas la URL del Paso 3 (solo existe después de activar GitHub Pages). Pégala en el
   campo correspondiente.
2. Indica hasta qué número de mesa quieres generar (o edita la lista de texto directamente
   para usar nombres como "Terraza 1", "Barra", etc.).
3. Click en **Generar QRs** — aparece un QR por mesa, ya etiquetado.
4. Click en **Imprimir** para mandarlos a la impresora (cada uno queda listo para recortar).

Si prefieres no usarla, también puedes generar cada QR manualmente con cualquier generador de
QR gratuito, pegando una por una las URLs con `?mesa=` del ejemplo de arriba.

Una vez impresos, pégalos en la mesa correspondiente — de ahí en adelante, lo único que el
personal debe vigilar es que el QR físico quede en la mesa correcta.

Si el cliente entra sin `?mesa=` en la URL (por ejemplo, compartes el link general por
Instagram), el menú funciona igual mostrando el nombre por defecto (sin el aviso), pero no
aparece ningún número de mesa en el mensaje de WhatsApp.

## Paso 6 — Panel de administración (marcar productos agotados)

`docs/admin.html` es un panel protegido con contraseña donde el personal puede marcar
productos como "agotado" (se muestran tachados/grises en el menú, sin poder agregarse al
carrito) — útil para cuando se acaba algo a mitad del turno, sin esperar a Loyverse.

Como el sitio es estático (sin servidor propio), guardar ese cambio en vivo requiere un
pequeño backend intermedio: un **Cloudflare Worker** gratuito que recibe la contraseña,
la valida, y si es correcta usa un token de GitHub (que nunca toca el navegador) para
actualizar el menú publicado. Es exactamente el mismo principio de seguridad que usamos con
el token de Loyverse — el secreto vive en un solo lugar, protegido, nunca en el código público.

### 6.1 — Crear el Worker en Cloudflare

1. Crea una cuenta gratuita en [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. En el menú lateral: **Workers y Pages → Create → Create Worker**. Dale un nombre (ej.
   `admin-worker`) y créalo.
3. Click en **Edit code** (o "Quick edit"). Borra el código de ejemplo y pega todo el contenido
   de [`cloudflare-worker/admin-worker.js`](cloudflare-worker/admin-worker.js) de este repo.
4. Click en **Deploy** (o "Save and deploy").
5. Copia la URL que te asigna Cloudflare, algo como `https://admin-worker.tu-usuario.workers.dev`.

### 6.2 — Generar el token de GitHub para el Worker

**Este token solo debe tener permiso sobre este repositorio** (no acceso general a tu cuenta):

1. GitHub → foto de perfil → **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**.
2. **Repository access**: elige "Only select repositories" y selecciona este repositorio.
3. **Permissions → Repository permissions → Contents**: cambia a **Read and write**. Deja
   todo lo demás sin acceso.
4. Ponle una fecha de expiración razonable (ej. 1 año) y genera el token.
5. Copia el token (`github_pat_...`) — no lo vuelves a ver después de esta pantalla.

### 6.3 — Configurar las variables del Worker

En tu Worker: **Settings → Variables and Secrets → Add**. Agrega estas 4 (marca "Encrypt"
en las que son secretas):

| Nombre | Valor | Tipo |
|---|---|---|
| `ADMIN_PASSWORD` | La contraseña que usará el personal | Secret |
| `GITHUB_TOKEN` | El token que generaste en 6.2 | Secret |
| `GITHUB_REPO` | `Masterpiece26/88-Grados-Caf---Men-Digital.html` | Texto |
| `ALLOWED_ORIGIN` | `https://masterpiece26.github.io` | Texto |

Guarda y vuelve a desplegar si te lo pide.

### 6.4 — Conectar admin.html con tu Worker

Edita `docs/admin.html`, busca la línea:
```js
const WORKER_URL = 'PON_AQUI_LA_URL_DE_TU_WORKER';
```
y reemplázala con la URL real de tu Worker (la del paso 6.1). Sube el cambio.

### 6.5 — Usar el panel

Abre `https://masterpiece26.github.io/88-Grados-Caf---Men-Digital.html/admin.html`, entra con
la contraseña, busca el producto y apaga/enciende el interruptor. El cambio se ve en el menú
en menos de un minuto (y queda protegido de que la próxima sincronización con Loyverse lo
borre). Guarda esa URL — no está enlazada desde ningún lado del menú público.

## Editar el menú (productos, categorías, fotos, modificadores)

Edita `catalog/menu-catalog.json` — **no `docs/data/menu-data.json`**:

- Cambiar/agregar productos, categorías, descripciones, tags, tamaños o modificadores: edítalo
  directamente en ese archivo siguiendo la estructura existente.
- Los precios que pongas aquí son el "respaldo" inicial — la próxima sincronización los
  reemplazará por el precio real de Loyverse si encuentra el producto.

### Fotos de los productos

Si le subes una foto a un producto en el Back Office de Loyverse (Productos → el producto →
foto), `scripts/sync-loyverse.js` la trae automáticamente en cada sincronización, igual que el
precio — no tienes que hacer nada más aquí. Sin foto en Loyverse, se muestra un cuadro con el
nombre del producto como ahora.

Si prefieres poner una foto que no está en Loyverse, agrega manualmente `"image": "URL-de-la-foto"`
al item en `menu-catalog.json` — se usará mientras Loyverse no tenga una foto propia para ese
producto; en cuanto Loyverse tenga una, la reemplaza.

## Cuando un producto no se actualiza automáticamente

Revisa el log de la Action (Actions → última ejecución → sync). Verás advertencias como:

- **"no se encontró ningún producto con ese nombre en Loyverse"** → el nombre en Loyverse no
  coincide exactamente con el de tu menú. Solución: en `menu-catalog.json`, agrega al item el
  campo `"loyverseItemName": "Nombre exacto en Loyverse"` para forzar el emparejamiento sin
  tener que renombrar tu menú.
- **"emparejado por posición, verifica que el orden coincida"** (productos con tamaños) → el
  producto en Loyverse no tiene nombres de variante (Pequeño/Mediano/Grande), así que se
  emparejó por el orden en que aparecen. Revisa que el orden de tamaños en Loyverse coincida
  con el de tu menú, o nómbralos en Loyverse para mayor seguridad.
- **"Nombre ambiguo"** → tienes dos productos con el mismo nombre en Loyverse; renómbralos ahí
  para distinguirlos, o usa `loyverseItemName` combinado con otro dato único si aplica.

Los grupos de modificadores (`MODIFIER_GROUPS`, ej. extras de pizza) **no se sincronizan
automáticamente** — sus precios se editan a mano en `menu-catalog.json`.

### Emparejamiento estable por ID (recomendado si un producto cambia de nombre seguido)

Cada sincronización también escribe `catalog/loyverse-snapshot.json` — un espejo de tu
catálogo real de Loyverse (ID, nombre, categoría, variantes de cada producto). Con el ID real
de ahí, puedes fijar el emparejamiento de forma permanente en `menu-catalog.json`:

```json
{ "id": "cafe-lungo", "name": "Café Lungo", "cat": "cafe", "price": 880, "loyverseItemId": "abc123..." }
```

Con `loyverseItemId` fijado, ese producto se sigue emparejando aunque le cambies el nombre en
Loyverse más adelante — deja de depender de que los nombres coincidan exactamente.

También funciona **por talla**: si en Loyverse cada tamaño es un producto completamente
separado (ej. "Agua Pequeña", "Agua Mediana", "Agua Grande" en vez de variantes de un mismo
"Agua" — muy común), fija el ID dentro de cada size:

```json
{ "label": "Pequeña", "price": 570, "loyverseItemId": "abc123..." }
```

166 de los 166 productos del menú ya están revisados: 163 emparejados (la mayoría por ID,
fijados a partir de `catalog/loyverse-snapshot.json` cruzando nombre + precio). Los 3 que
quedan sin emparejar (Macchiato, Pizza Pepperoni, Torta de Auyama) se confirmó que no existen
como productos en Loyverse — si los creas ahí, agrégales el `loyverseItemId` para que se
sincronicen también; mientras tanto mantienen el precio que pongas a mano en el catálogo.

## Número de WhatsApp para pedidos

Está definido en `docs/index.html` como `const WHATSAPP_NUMBER = '582123340106';`. Cámbialo ahí
si necesitas actualizarlo.

## Datos del cliente antes de enviar el pedido

Antes de habilitar el envío por WhatsApp, el carrito pide **nombre y apellido** (obligatorios)
para que puedas identificar cada pedido. Ambos se incluyen al inicio del mensaje de WhatsApp
("Hola 88° Grados Café, soy Nombre Apellido y quiero hacer este pedido..."). Si faltan, se
muestra un aviso y no se abre WhatsApp.

## Probar el sitio en tu computadora antes de subir cambios

```
node scripts/dev-server.js
```

Luego abre `http://localhost:8879` en el navegador. Sirve exactamente la carpeta `docs/`, igual
que lo hará GitHub Pages en producción. (Abrir `docs/index.html` directamente con doble-click
no funciona porque el navegador bloquea la carga de `data/menu-data.json` por seguridad cuando
no hay un servidor de por medio.)

## Estadísticas de uso (visitas al menú)

Recomendado: **Cloudflare Web Analytics** — gratis, no requiere mover tu dominio a Cloudflare,
y usas la misma cuenta que ya creaste para el panel de administración (Paso 6).

1. En Cloudflare: **Analytics & Logs → Web Analytics → Add a site**.
2. Pon `masterpiece26.github.io` como sitio (no pide cambiar DNS ni nada del hosting).
3. Te da un fragmento `<script>` con un token — pégalo antes de `</head>` en `docs/index.html`.
4. Sube el cambio. Las visitas empiezan a verse en el dashboard de Cloudflare (Analytics &
   Logs → Web Analytics) unos minutos después.

Si prefieres otra opción, [GoatCounter](https://www.goatcounter.com) es igual de simple
(cuenta gratuita aparte, también un solo `<script>`) y su panel es público por defecto salvo
que lo configures como privado.

## Seguridad

- El token de Loyverse vive únicamente como GitHub Secret y se usa solo dentro de GitHub
  Actions — nunca llega al navegador ni aparece en el código fuente del sitio.
- `docs/data/menu-data.json` solo contiene nombres, categorías y precios — información que de
  todas formas es pública en tu menú físico.
- Todo lo que no está en `docs/` (catálogo maestro, scripts, herramienta de QR) no está
  publicado como sitio web — GitHub Pages solo sirve `/docs`. El repositorio en sí es público
  en GitHub (ver nota en "Estructura del proyecto"), así que esto es organización, no una
  barrera de seguridad real.
- El token de GitHub del panel de administración (`GITHUB_TOKEN` del Worker) vive únicamente
  en Cloudflare, cifrado — nunca toca el navegador ni el repositorio. Está limitado (permiso
  "fine-grained") a leer/escribir solo este repositorio, nada más de tu cuenta de GitHub.
- La contraseña del panel (`ADMIN_PASSWORD`) es la única barrera antes de poder guardar
  cambios — trátala como cualquier contraseña de trabajo: compártela solo con el personal que
  la necesite y cámbiala en el Worker si alguien que ya no debería tenerla la conoce.
