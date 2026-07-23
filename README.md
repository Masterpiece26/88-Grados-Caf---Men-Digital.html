Menu Interactivo de 88 Grados Café, C.A.

## Estadísticas de uso del menú (panel de administración)

La pestaña "Estadísticas" de `docs/admin.html` muestra visitas, productos más vistos,
búsquedas, agregados al carrito y pedidos enviados, con filtros de tiempo (Hoy / 7 días /
30 días / Todo). Los datos se guardan en una base de datos D1 de Cloudflare (gratuita) —
hay que crearla y vincularla al Worker una sola vez.

### Crear la base de datos D1

1. En Cloudflare: **Workers y Pages → D1 SQL Database → Create database**. Ponle un nombre,
   ej. `menu-stats`.
2. Abre la base de datos creada → pestaña **Console** → pega y ejecuta:
   ```sql
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     type TEXT NOT NULL,
     item_id TEXT,
     query TEXT,
     mesa TEXT
   );
   ```

### Vincular la base de datos al Worker

1. Ve a tu Worker (`admin-worker`) → **Settings → Bindings → Add → D1 database**.
2. **Variable name**: `DB` (exacto, en mayúsculas — el código del Worker lo espera así).
3. **D1 database**: selecciona `menu-stats` (la que acabas de crear).
4. Guarda y despliega si te lo pide.

### Actualizar el código del Worker

El código de `cloudflare-worker/admin-worker.js` en este repositorio ya incluye el registro
de eventos (`track`) y las estadísticas (`stats`). Si tu Worker en Cloudflare tiene una
versión anterior, vuelve a copiar y pegar el archivo completo ahí (Edit code → seleccionar
todo, borrar, pegar el contenido actualizado → Deploy) — el mismo procedimiento que usaste
para desplegarlo la primera vez.

No hace falta ningún cambio en `docs/index.html` ni en `docs/admin.html`: ambos ya están
preparados para usar la base de datos en cuanto esté vinculada. Los eventos que el menú
envía mientras la base de datos todavía no existe simplemente no se guardan (no rompen nada
para el cliente).
