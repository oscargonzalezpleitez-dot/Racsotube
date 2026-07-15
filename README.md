# Racsotube 📺🕶️

Cliente de YouTube para las gafas **Meta Ray-Ban Display**, construido como Web App
estándar (HTML/CSS/JS, sin frameworks) sobre el **Meta Wearables Web App SDK**
(developer preview). Diseñado para la pantalla del lente de **600×600 px**:
fondo negro (transparente en el display de guía de onda), texto grande, alto
contraste y navegación lineal por gestos.

## Características

- 🔍 Búsqueda de videos con **YouTube Data API v3** (paginación con "Más resultados").
- ▶️ Reproducción con el **YouTube IFrame Player API** (autoplay, controles mínimos,
  play/pausa por gesto, video 16:9 centrado en el cuadrado 600×600).
- 🕘 Historial en `localStorage`: búsquedas recientes (chips) y últimos videos vistos.
- 🎛️ Entrada multi-modal con las mismas 4 acciones (anterior / siguiente / seleccionar / volver):
  - **Escritorio:** flechas ↑↓←→, `Enter`, `Escape`/`Backspace`, mouse.
  - **Táctil:** swipe vertical (mover foco), tap (seleccionar), swipe a la derecha (volver).
  - **Gafas:** listeners opcionales para Neural Band / Cap Touch con
    *feature-detection* (`if (window.MetaWearables) {...}`) — la app funciona
    idéntica en un navegador normal si el SDK no está presente.
- ⚠️ Manejo de errores claro: API key inválida, cuota agotada, sin conexión,
  video no reproducible, sin resultados.

## Archivos

| Archivo | Descripción |
|---|---|
| `index.html` | Estructura: pantallas de inicio, resultados y reproductor |
| `style.css` | Estilos dark-mode optimizados para 600×600 |
| `app.js` | Lógica: búsqueda, navegación por foco, reproducción, gestos |
| `config.js` | Tu API key (**no versionado**, está en `.gitignore`) |
| `config.example.js` | Plantilla pública de `config.js` |

## 1. Obtener la API key de YouTube Data API v3

1. Entra a [Google Cloud Console](https://console.cloud.google.com/) y crea un proyecto.
2. **APIs y servicios → Biblioteca**, busca **"YouTube Data API v3"** y pulsa **Habilitar**.
3. **APIs y servicios → Credenciales → Crear credenciales → Clave de API**.
4. Copia la clave en `config.js`:
   ```js
   const YOUTUBE_API_KEY = "AIza...tu-clave...";
   ```
5. **Recomendado:** restringe la clave a "YouTube Data API v3" y a los referers
   HTTP de tu app (la URL donde la despliegues), para que no pueda abusarse de
   ella si se filtra.

> 💰 La API tiene una cuota gratuita diaria (10 000 unidades). Cada búsqueda
> cuesta 100 unidades ≈ **100 búsquedas/día** gratis.

## 2. Probar en un navegador de escritorio

La app no necesita build ni dependencias; solo un servidor estático (la IFrame
API de YouTube no funciona bien desde `file://`):

```bash
# Con Python
python -m http.server 8080

# O con Node
npx serve -l 8080
```

Abre `http://localhost:8080` y simula la pantalla del lente:

- La app ya se auto-limita a 600×600 y se centra en pantallas grandes, **o**
- Abre DevTools (`F12`) → modo dispositivo (`Ctrl+Shift+M`) → dimensiones
  personalizadas **600 × 600**.

Navega con las **flechas** del teclado, `Enter` para seleccionar y `Escape`
para volver — exactamente el mismo modelo de interacción que tendrás con
gestos en las gafas.

## 3. Probar en las Meta Ray-Ban Display

1. **Regístrate como developer** en <https://wearables.developer.meta.com/>
   con tu cuenta Meta y acepta los términos del developer preview.
2. Revisa la guía oficial de Web Apps:
   <https://wearables.developer.meta.com/docs/develop/webapps/> y el starter
   kit de referencia:
   <https://github.com/facebookincubator/meta-wearables-webapp>.
3. **Despliega la app en una URL HTTPS** (Vercel, Netlify, GitHub Pages…).
   Como `config.js` contiene tu API key, protege el acceso:
   - Usa una URL **protegida con contraseña** (p. ej. Vercel/Netlify con
     protección por contraseña, o basic auth en tu servidor), y/o
   - Restringe la API key por referer HTTP en Google Cloud Console.
4. En el portal de developers de Meta, **registra la Web App con su URL** y
   asóciala a tu cuenta/dispositivo según el flujo del developer preview.
5. Con las gafas emparejadas a la app Meta AI del teléfono, abre la Web App
   desde el launcher de apps de las gafas. Los gestos del **Neural Band**
   (pellizco = seleccionar, deslizar = mover el foco) y del **Cap Touch** de la
   montura quedan mapeados a la misma navegación que probaste con teclado.

## Limitaciones conocidas (developer preview)

- **No hay tienda pública** de apps para las gafas todavía; la distribución es
  solo mediante canales de release para desarrolladores.
- Máximo **~100 testers** por canal de release del developer preview.
- **El SDK de eventos de gestos puede cambiar**: los nombres de eventos del
  Neural Band/Cap Touch en `app.js` (`initWearableInput()`) son un mapeo
  tentativo tras `feature-detection`; ajústalos a la versión vigente de la
  documentación oficial. Mientras tanto, la app funciona completa con los
  eventos DOM estándar.
- **Sin teclado físico en las gafas:** la búsqueda por texto libre depende del
  dictado por voz del sistema o de los chips de búsquedas recientes. En
  escritorio se escribe normalmente.
- Algunos videos de YouTube **no permiten inserción** (embedding) y no se
  reproducirán en el player — la app muestra un aviso y permite elegir otro.
- La cuota gratuita de la YouTube Data API limita el número de búsquedas diarias.
- La pantalla del lente es monocular y de brillo variable: evita depender de
  colores sutiles (por eso el foco es un borde amarillo grueso).

## Seguridad de la API key

`config.js` está en `.gitignore` y **nunca debe subirse a un repositorio
público**. Ten en cuenta que en una web app pura la clave siempre viaja al
cliente: la mitigación real es **restringir la clave por API y por referer**
en Google Cloud Console y proteger la URL de despliegue con contraseña. Para
producción seria, lo correcto sería un pequeño backend proxy que guarde la
clave del lado del servidor.
