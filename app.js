/**
 * app.js — Racsotube: cliente de YouTube para Meta Ray-Ban Display
 * ----------------------------------------------------------------
 * Arquitectura:
 *  - 3 pantallas (inicio, resultados, reproductor) alternadas con [hidden].
 *  - Navegación por FOCO: una lista lineal de elementos [data-focusable];
 *    los gestos/teclas mueven el foco y "seleccionar" activa el elemento.
 *  - Entradas soportadas (todas convergen en las mismas 4 acciones
 *    prev / next / select / back):
 *      · Teclado (escritorio):   ↑/↓ o ←/→, Enter, Escape/Backspace
 *      · Táctil (escritorio/preview): swipe vertical, tap, swipe derecha = atrás
 *      · Neural Band / Cap Touch (gafas): listeners opcionales con
 *        feature-detection sobre window.MetaWearables — ver initWearableInput().
 *  - Datos: YouTube Data API v3 (búsqueda) + YouTube IFrame Player API
 *    (reproducción, cargada bajo demanda).
 *  - Persistencia: localStorage (búsquedas recientes y últimos videos vistos).
 */
"use strict";

/* ============================================================
 * Constantes y estado
 * ============================================================ */
const SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const MAX_RESULTS_PER_PAGE = 6;   // pocos elementos por pantalla (lente 600x600)
const MAX_RECENT_SEARCHES = 6;
const MAX_RECENT_VIDEOS = 4;
const LS_SEARCHES_KEY = "racsotube.recentSearches";
const LS_VIDEOS_KEY = "racsotube.recentVideos";
const LS_PAIR_KEY = "racsotube.pairCode";     // código propio (para recibir)
const LS_TARGET_KEY = "racsotube.sendTarget"; // último código al que se envió
const LS_TOKENS_KEY = "racsotube.oauthTokens"; // tokens de la cuenta de YouTube

// OAuth 2.0 "device flow" de Google (el de las Smart TV: código + google.com/device)
const OAUTH_DEVICE_URL = "https://oauth2.googleapis.com/device/code";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const YT_API = "https://www.googleapis.com/youtube/v3";

// Servicio público de mensajería (pub/sub) usado para "enviar a los lentes":
// el teléfono publica el video en un topic y las gafas lo reciben por SSE.
// Solo viajan IDs/títulos de videos; el topic incluye un código aleatorio.
const NTFY_TOPIC_PREFIX = "https://ntfy.sh/racsotube-";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin caracteres confusos

// Sugerencias para poder buscar con un solo pellizco cuando no hay historial
const SUGGESTED_SEARCHES = ["música", "noticias", "lofi", "deportes", "tecnología", "recetas"];

// Distribución del teclado en pantalla (navegable por gestos)
const KB_ROWS = [
  [..."1234567890"],
  [..."qwertyuiop"],
  [..."asdfghjklñ"],
  [..."zxcvbnm", "⌫"],
  ["✕", "␣", "OK"],
];

const state = {
  screen: "home",          // "home" | "results" | "player"
  focusables: [],          // elementos navegables de la pantalla actual
  focusIndex: 0,
  query: "",               // búsqueda activa
  nextPageToken: null,     // paginación de la YouTube Data API
  player: null,            // instancia de YT.Player
  playerReady: false,
  iframeApiLoading: false,
  pendingVideo: null,      // video a reproducir cuando la IFrame API termine de cargar
  autoMuted: false,        // true si el video arrancó silenciado por bloqueo de autoplay
  playerNavigated: false,  // true si el usuario movió el foco dentro del reproductor
  pendingSend: null,       // video a enviar cuando se confirme el código de destino
  kbMode: "search",        // "search" | "code" — uso actual del teclado en pantalla
  kbText: "",              // texto compuesto en el teclado en pantalla
  kbPhysical: false,       // true si se escribió con teclado físico (Enter = confirmar)
  resultsMode: "search",   // qué muestra la lista: "search" | "subs" | "channel" | "likes"
  playerOrigin: "home",    // pantalla desde la que se abrió el reproductor
  loginAbort: false,       // cancela el sondeo del login en curso
};

// Accesos directos al DOM
const $ = (id) => document.getElementById(id);
const el = {
  home: $("screen-home"),
  results: $("screen-results"),
  player: $("screen-player"),
  searchBtn: $("search-btn"),
  recentSearchesBlock: $("recent-searches-block"),
  recentSearches: $("recent-searches"),
  recentVideosBlock: $("recent-videos-block"),
  recentVideos: $("recent-videos"),
  resultsTitle: $("results-title"),
  resultsList: $("results-list"),
  playerTitle: $("player-title"),
  loader: $("loader"),
  errorPanel: $("error-panel"),
  errorMessage: $("error-message"),
  errorDismiss: $("error-dismiss"),
  keyboard: $("keyboard"),
  kbLabel: $("kb-label"),
  kbPreview: $("kb-preview"),
  kbRows: $("kb-rows"),
  toast: $("toast"),
  pairCode: $("pair-code"),
  sendBtn: $("send-btn"),
  accountBlock: $("account-block"),
  accountActions: $("account-actions"),
  loginPanel: $("login-panel"),
  loginCode: $("login-code"),
  loginStatus: $("login-status"),
  loginCancel: $("login-cancel"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
 * Persistencia en localStorage
 * ============================================================ */
function loadJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return []; // dato corrupto: se ignora
  }
}

function saveRecentSearch(query) {
  const list = loadJSON(LS_SEARCHES_KEY).filter(
    (q) => q.toLowerCase() !== query.toLowerCase()
  );
  list.unshift(query);
  localStorage.setItem(LS_SEARCHES_KEY, JSON.stringify(list.slice(0, MAX_RECENT_SEARCHES)));
}

function saveRecentVideo(video) {
  const list = loadJSON(LS_VIDEOS_KEY).filter((v) => v.id !== video.id);
  list.unshift(video);
  localStorage.setItem(LS_VIDEOS_KEY, JSON.stringify(list.slice(0, MAX_RECENT_VIDEOS)));
}

/* ============================================================
 * Sistema de foco / navegación lineal
 * ============================================================ */

/** Reconstruye la lista de elementos navegables de la capa visible.
 *  Prioridad de capas: panel de error > teclado en pantalla > pantalla actual. */
function refreshFocusables(preferredIndex = 0) {
  let scope = currentScreenEl();
  if (!el.keyboard.hidden) scope = el.keyboard;
  if (!el.loginPanel.hidden) scope = el.loginPanel;
  if (!el.errorPanel.hidden) scope = el.errorPanel;
  state.focusables = Array.from(scope.querySelectorAll("[data-focusable]"));
  state.focusIndex = Math.min(preferredIndex, state.focusables.length - 1);
  applyFocus();
}

function kbOpen() {
  return !el.keyboard.hidden;
}

function currentScreenEl() {
  return { home: el.home, results: el.results, player: el.player }[state.screen];
}

/** Aplica el estilo de foco al elemento activo y lo hace visible (scroll). */
function applyFocus() {
  state.focusables.forEach((f, i) => {
    f.classList.toggle("focused", i === state.focusIndex);
  });
  const active = state.focusables[state.focusIndex];
  if (active) {
    active.focus({ preventScroll: true });
    active.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function moveFocus(delta) {
  if (!state.focusables.length) return;
  const n = state.focusables.length;
  state.focusIndex = (state.focusIndex + delta + n) % n; // navegación circular
  // En el reproductor, mover el foco indica intención de usar los botones
  // (←, 📲): el siguiente "seleccionar" los activará en vez de pausar
  if (state.screen === "player") state.playerNavigated = true;
  applyFocus();
}

/** Activa el elemento con foco (equivale a un click). */
function selectFocused() {
  const active = state.focusables[state.focusIndex];
  if (active) active.click();
}

/* ============================================================
 * Cambio de pantallas
 * ============================================================ */
function showScreen(name) {
  state.screen = name;
  state.playerNavigated = false;
  el.home.hidden = name !== "home";
  el.results.hidden = name !== "results";
  el.player.hidden = name !== "player";
  refreshFocusables();
}

function goBack() {
  if (!el.errorPanel.hidden) {
    hideError();
    return;
  }
  if (!el.loginPanel.hidden) {
    cancelLogin();
    return;
  }
  if (kbOpen()) {
    closeKeyboard();
    return;
  }
  if (state.screen === "player") {
    // Detener el video al salir para no seguir gastando batería/datos
    if (state.player && state.playerReady) state.player.stopVideo();
    if (state.playerOrigin === "results" && el.resultsList.children.length) {
      showScreen("results");
    } else {
      renderHome(); // refrescar "vistos recientemente" con el video recién visto
      showScreen("home");
    }
  } else if (state.screen === "results") {
    // Desde los videos de un canal se vuelve a la lista de suscripciones
    if (state.resultsMode === "channel") {
      showSubscriptions();
      return;
    }
    renderHome();
    showScreen("home");
  }
  // En "home" no hay nivel superior: no se hace nada
}

/* ============================================================
 * Overlays: carga y errores
 * ============================================================ */
function setLoading(on) {
  el.loader.hidden = !on;
}

function showError(message) {
  el.errorMessage.textContent = message;
  el.errorPanel.hidden = false;
  refreshFocusables(); // el foco pasa al botón "Entendido"
}

function hideError() {
  el.errorPanel.hidden = true;
  refreshFocusables();
}

/** Traduce errores de la API / red a mensajes claros para el usuario. */
function describeApiError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || "";
  if (status === 400 && reason === "keyInvalid") {
    return "La API key de YouTube no es válida. Revisa config.js y verifica la clave en Google Cloud Console.";
  }
  if (status === 403 && reason === "quotaExceeded") {
    return "Se agotó la cuota diaria de la YouTube Data API. Inténtalo de nuevo mañana o usa otra clave.";
  }
  if (status === 403) {
    return "Acceso denegado por la API de YouTube. Verifica que 'YouTube Data API v3' esté habilitada para tu clave y que sus restricciones permitan este origen.";
  }
  return `Error de la API de YouTube (código ${status}). Inténtalo de nuevo.`;
}

/* ============================================================
 * Búsqueda — YouTube Data API v3
 * ============================================================ */
function apiKeyConfigured() {
  return (
    typeof YOUTUBE_API_KEY === "string" &&
    YOUTUBE_API_KEY.length > 10 &&
    YOUTUBE_API_KEY !== "TU_API_KEY_AQUI"
  );
}

/**
 * Busca videos. Si pageToken es null empieza una búsqueda nueva;
 * si trae valor, añade la siguiente página a la lista actual.
 */
async function searchVideos(query, pageToken = null) {
  if (!apiKeyConfigured()) {
    showError("Falta configurar la API key de YouTube. Abre config.js y sigue las instrucciones para obtenerla en Google Cloud Console.");
    return;
  }
  if (!navigator.onLine) {
    showError("Sin conexión a internet. Conecta las gafas/el teléfono a una red e inténtalo de nuevo.");
    return;
  }

  setLoading(true);
  try {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      maxResults: String(MAX_RESULTS_PER_PAGE),
      q: query,
      key: YOUTUBE_API_KEY,
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${SEARCH_ENDPOINT}?${params}`);
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      showError(describeApiError(res.status, body));
      return;
    }

    const items = (body.items || [])
      .filter((it) => it.id?.videoId)
      .map((it) => ({
        id: it.id.videoId,
        title: decodeEntities(it.snippet.title),
        channel: decodeEntities(it.snippet.channelTitle),
        thumb: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || "",
      }));

    state.nextPageToken = body.nextPageToken || null;

    if (!pageToken) {
      // Búsqueda nueva
      state.resultsMode = "search";
      state.query = query;
      saveRecentSearch(query);
      el.resultsTitle.textContent = `“${query}”`;
      el.resultsList.innerHTML = "";
      if (!items.length) {
        showError(`Sin resultados para “${query}”. Prueba con otras palabras.`);
        return;
      }
      showScreen("results");
    }

    appendResults(items);
    refreshFocusables(pageToken ? state.focusIndex : 0);
  } catch {
    // fetch lanza TypeError ante fallos de red/DNS
    showError("No se pudo conectar con YouTube. Revisa tu conexión a internet e inténtalo de nuevo.");
  } finally {
    setLoading(false);
  }
}

/** La API devuelve títulos con entidades HTML (&amp;, &#39;…): se decodifican. */
function decodeEntities(text) {
  const ta = document.createElement("textarea");
  ta.innerHTML = text;
  return ta.value;
}

/* ============================================================
 * Render de listas
 * ============================================================ */
function makeVideoItem(video) {
  const btn = document.createElement("button");
  btn.className = "video-item";
  btn.setAttribute("data-focusable", "");
  btn.setAttribute("role", "listitem");

  const img = document.createElement("img");
  img.src = video.thumb;
  img.alt = "";
  img.loading = "lazy";

  const meta = document.createElement("div");
  meta.className = "meta";
  const title = document.createElement("p");
  title.className = "title";
  title.textContent = video.title;
  const channel = document.createElement("p");
  channel.className = "channel";
  channel.textContent = video.channel;
  meta.append(title, channel);

  btn.append(img, meta);
  btn.addEventListener("click", () => playVideo(video));
  return btn;
}

/** Añade resultados a la lista y (re)coloca el botón "Más resultados". */
function appendResults(items) {
  // Quitar el "Más resultados" anterior antes de añadir la página nueva
  el.resultsList.querySelector(".load-more")?.remove();

  items.forEach((v) => el.resultsList.appendChild(makeVideoItem(v)));

  if (state.nextPageToken) {
    const more = document.createElement("button");
    more.className = "video-item load-more";
    more.setAttribute("data-focusable", "");
    more.textContent = "Más resultados ↓";
    more.addEventListener("click", () => searchVideos(state.query, state.nextPageToken));
    el.resultsList.appendChild(more);
  }
}

/** Pinta los bloques de la pantalla de inicio desde localStorage. */
function renderHome() {
  // Chips: historial de búsquedas o, si aún no hay, sugerencias
  // (así siempre se puede buscar con un solo pellizco, sin teclado)
  const searches = loadJSON(LS_SEARCHES_KEY);
  const chips = searches.length ? searches : SUGGESTED_SEARCHES;
  el.recentSearchesBlock.hidden = false;
  el.recentSearchesBlock.querySelector(".block-title").textContent =
    searches.length ? "Búsquedas recientes" : "Sugerencias";
  el.recentSearches.innerHTML = "";
  chips.forEach((q) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.setAttribute("data-focusable", "");
    chip.setAttribute("role", "listitem");
    chip.textContent = q;
    chip.addEventListener("click", () => searchVideos(q));
    el.recentSearches.appendChild(chip);
  });

  // Últimos videos vistos
  const videos = loadJSON(LS_VIDEOS_KEY);
  el.recentVideosBlock.hidden = !videos.length;
  el.recentVideos.innerHTML = "";
  videos.forEach((v) => el.recentVideos.appendChild(makeVideoItem(v)));

  // Chips de "Mi cuenta" (login / suscripciones / me gusta)
  renderAccountBlock();

  refreshFocusables();
}

/* ============================================================
 * Reproducción — YouTube IFrame Player API
 * ============================================================ */

/** Carga el script oficial de la IFrame API una sola vez, bajo demanda. */
function loadIframeApi() {
  if (window.YT?.Player || state.iframeApiLoading) return;
  state.iframeApiLoading = true;
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
}

// Callback global que invoca la IFrame API cuando termina de cargar
window.onYouTubeIframeAPIReady = function () {
  if (state.pendingVideo) {
    const video = state.pendingVideo;
    state.pendingVideo = null;
    createPlayer(video);
  }
};

function createPlayer(video) {
  state.player = new YT.Player("player-frame", {
    videoId: video.id,
    playerVars: {
      autoplay: 1,        // reproducir al seleccionar
      controls: 0,        // sin controles del iframe: se maneja por gestos
      rel: 0,             // sin videos relacionados de otros canales
      playsinline: 1,
      modestbranding: 1,
    },
    events: {
      onReady: (e) => {
        state.playerReady = true;
        // Si mientras se inicializaba se pidió otro video, cargarlo ahora
        if (state.pendingVideo) {
          e.target.loadVideoById(state.pendingVideo.id);
          state.pendingVideo = null;
        } else {
          e.target.playVideo();
        }
      },
      onError: (e) => {
        // Códigos de la IFrame API: 2/100 = video inválido o eliminado,
        // 101/150 = el canal no permite reproducirlo insertado, 5 = error HTML5
        const code = e?.data;
        const msg =
          code === 101 || code === 150
            ? "El canal no permite reproducir este video fuera de YouTube. Prueba con otro resultado."
            : code === 2 || code === 100
              ? "Este video no existe o fue eliminado. Prueba con otro resultado."
              : "No se pudo reproducir el video. Prueba con otro resultado.";
        showError(msg);
      },
    },
  });
}

function playVideo(video) {
  if (state.screen !== "player") state.playerOrigin = state.screen;
  state.autoMuted = false;
  if (state.player && state.playerReady) state.player.unMute();
  saveRecentVideo(video);
  el.playerTitle.textContent = video.title;
  showScreen("player");
  setLoading(true);

  if (window.YT?.Player) {
    if (state.player && state.playerReady) {
      state.player.loadVideoById(video.id); // reutilizar el reproductor existente
    } else if (!state.player) {
      createPlayer(video);
    } else {
      state.pendingVideo = video; // player creado pero aún no listo
    }
  } else {
    // Primera reproducción: cargar la IFrame API y reproducir al estar lista
    state.pendingVideo = video;
    loadIframeApi();
  }
  // El loader se oculta en cuanto el reproductor empieza a emitir estados
  waitForPlayback();
}

/**
 * Oculta el loader cuando el video empieza (o tras un tiempo máximo).
 * Si el navegador bloquea el autoplay con sonido (política de Chrome en
 * iframes), a los ~3.5 s reintenta silenciado — el autoplay sin audio
 * siempre está permitido — y el sonido se reactiva con el primer gesto.
 */
function waitForPlayback() {
  const started = Date.now();
  let mutedFallbackTried = false;
  const check = setInterval(() => {
    const playing =
      state.playerReady &&
      state.player?.getPlayerState &&
      state.player.getPlayerState() === YT.PlayerState.PLAYING;
    const elapsed = Date.now() - started;

    if (!playing && !mutedFallbackTried && elapsed > 3500 && state.playerReady) {
      mutedFallbackTried = true;
      state.autoMuted = true;
      state.player.mute();
      state.player.playVideo();
    }
    if (playing || elapsed > 10000) {
      clearInterval(check);
      setLoading(false);
      if (!playing && !navigator.onLine) {
        showError("Sin conexión: no se pudo cargar el video.");
      }
    }
  }, 250);
}

/** Alterna reproducción/pausa (gesto "seleccionar" dentro del reproductor). */
function togglePlayback() {
  if (!state.player || !state.playerReady) return;
  // Si el video arrancó silenciado por el fallback de autoplay,
  // el primer gesto reactiva el sonido en lugar de pausar
  if (state.autoMuted) {
    state.autoMuted = false;
    state.player.unMute();
    if (state.player.getPlayerState() !== YT.PlayerState.PLAYING) {
      state.player.playVideo();
    }
    return;
  }
  const s = state.player.getPlayerState();
  if (s === YT.PlayerState.PLAYING) state.player.pauseVideo();
  else state.player.playVideo();
}

/* ============================================================
 * Cuenta de YouTube — OAuth 2.0 "device flow" (como las Smart TV)
 * ------------------------------------------------------------
 * La app muestra un código; el usuario lo escribe en
 * google.com/device desde el teléfono y autoriza. La app sondea
 * el endpoint de tokens hasta recibir acceso. Los tokens viven
 * en localStorage y se renuevan solos con el refresh_token.
 * Requiere un cliente OAuth de tipo "TV y dispositivos de
 * entrada limitada" en config.js (ver README).
 * ============================================================ */
function oauthClientId() {
  return typeof OAUTH_CLIENT_ID === "string" ? OAUTH_CLIENT_ID : "";
}
function oauthClientSecret() {
  return typeof OAUTH_CLIENT_SECRET === "string" ? OAUTH_CLIENT_SECRET : "";
}
function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(LS_TOKENS_KEY));
  } catch {
    return null;
  }
}
function saveTokens(t) {
  localStorage.setItem(LS_TOKENS_KEY, JSON.stringify(t));
}
function clearTokens() {
  localStorage.removeItem(LS_TOKENS_KEY);
}
function isLoggedIn() {
  return !!loadTokens()?.refresh_token;
}

function oauthForm(params) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  };
}

/** Inicia el flujo de dispositivo: pide el código y arranca el sondeo. */
async function startLogin() {
  setLoading(true);
  try {
    const res = await fetch(OAUTH_DEVICE_URL, oauthForm({
      client_id: oauthClientId(),
      scope: OAUTH_SCOPE,
    }));
    const d = await res.json().catch(() => null);
    if (!res.ok || !d?.user_code) {
      showError("No se pudo iniciar el login de Google. Revisa el OAUTH_CLIENT_ID configurado.");
      return;
    }
    el.loginCode.textContent = d.user_code;
    el.loginStatus.textContent = "Esperando autorización…";
    el.loginPanel.hidden = false;
    refreshFocusables();
    pollForToken(d);
  } catch {
    showError("Sin conexión: no se pudo iniciar el login.");
  } finally {
    setLoading(false);
  }
}

function cancelLogin() {
  state.loginAbort = true;
  el.loginPanel.hidden = true;
  refreshFocusables();
}

/** Sondea el endpoint de tokens hasta que el usuario autorice (o caduque). */
async function pollForToken(d) {
  state.loginAbort = false;
  let interval = (d.interval || 5) * 1000;
  const deadline = Date.now() + (d.expires_in || 1800) * 1000;

  while (!state.loginAbort && Date.now() < deadline) {
    await sleep(interval);
    if (state.loginAbort) return;
    let body = null;
    try {
      const res = await fetch(OAUTH_TOKEN_URL, oauthForm({
        client_id: oauthClientId(),
        client_secret: oauthClientSecret(),
        device_code: d.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }));
      body = await res.json().catch(() => null);
    } catch {
      continue; // corte de red puntual: reintentar en el siguiente ciclo
    }
    if (body?.access_token) {
      saveTokens({
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: Date.now() + (body.expires_in || 3600) * 1000,
      });
      el.loginPanel.hidden = true;
      showToast("Sesión iniciada ✓");
      renderHome();
      return;
    }
    switch (body?.error) {
      case "authorization_pending":
        break; // el usuario aún no ha terminado en el teléfono
      case "slow_down":
        interval += 5000;
        break;
      case "access_denied":
        cancelLogin();
        showError("Rechazaste el acceso en Google.");
        return;
      default:
        cancelLogin();
        showError("El código caducó o falló el login. Inténtalo de nuevo.");
        return;
    }
  }
  if (!state.loginAbort) {
    cancelLogin();
    showError("El código caducó. Inténtalo de nuevo.");
  }
}

function logout() {
  clearTokens();
  showToast("Sesión cerrada");
  renderHome();
}

/** Devuelve un access token válido, renovándolo si hace falta. */
async function ensureAccessToken() {
  const t = loadTokens();
  if (!t?.refresh_token) throw new Error("no-auth");
  if (Date.now() < t.expires_at - 60000) return t.access_token;
  const res = await fetch(OAUTH_TOKEN_URL, oauthForm({
    client_id: oauthClientId(),
    client_secret: oauthClientSecret(),
    refresh_token: t.refresh_token,
    grant_type: "refresh_token",
  }));
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    clearTokens();
    throw new Error("session-expired");
  }
  t.access_token = body.access_token;
  t.expires_at = Date.now() + (body.expires_in || 3600) * 1000;
  saveTokens(t);
  return t.access_token;
}

/** GET autenticado contra la YouTube Data API. */
async function authFetch(path, params) {
  const token = await ensureAccessToken();
  const qs = new URLSearchParams(params);
  const res = await fetch(`${YT_API}/${path}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error("api-error");
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return body;
}

/** Traduce fallos de las secciones autenticadas a mensajes claros. */
function handleAccountError(err) {
  if (err.message === "no-auth" || err.message === "session-expired") {
    renderHome();
    showScreen("home");
    showError("Tu sesión de YouTube caducó. Vuelve a iniciar sesión.");
  } else if (!navigator.onLine) {
    showError("Sin conexión a internet.");
  } else {
    showError(describeApiError(err.status || 0, err.body));
  }
}

/* ---------- Pantallas de la cuenta ---------- */

/** Lista de canales a los que estás suscrito. */
async function showSubscriptions() {
  setLoading(true);
  try {
    const data = await authFetch("subscriptions", {
      part: "snippet",
      mine: "true",
      maxResults: "30",
      order: "alphabetical",
    });
    state.resultsMode = "subs";
    state.nextPageToken = null;
    el.resultsTitle.textContent = "Suscripciones";
    el.resultsList.innerHTML = "";
    (data.items || []).forEach((s) => {
      const ch = {
        id: s.snippet.resourceId.channelId,
        title: decodeEntities(s.snippet.title),
        thumb: s.snippet.thumbnails?.default?.url || "",
      };
      const btn = document.createElement("button");
      btn.className = "video-item";
      btn.setAttribute("data-focusable", "");
      const img = document.createElement("img");
      img.src = ch.thumb;
      img.alt = "";
      const meta = document.createElement("div");
      meta.className = "meta";
      const title = document.createElement("p");
      title.className = "title";
      title.textContent = ch.title;
      meta.appendChild(title);
      btn.append(img, meta);
      btn.addEventListener("click", () => showChannelVideos(ch));
      el.resultsList.appendChild(btn);
    });
    if (!el.resultsList.children.length) {
      showError("No tienes suscripciones en esta cuenta.");
      return;
    }
    showScreen("results");
  } catch (err) {
    handleAccountError(err);
  } finally {
    setLoading(false);
  }
}

/** Últimos videos subidos por un canal (vía su playlist de subidas). */
async function showChannelVideos(channel) {
  setLoading(true);
  try {
    const chData = await authFetch("channels", {
      part: "contentDetails",
      id: channel.id,
    });
    const uploads = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw new Error("api-error");
    const list = await authFetch("playlistItems", {
      part: "snippet",
      playlistId: uploads,
      maxResults: "10",
    });
    const items = (list.items || [])
      .filter((it) => it.snippet?.resourceId?.videoId)
      .map((it) => ({
        id: it.snippet.resourceId.videoId,
        title: decodeEntities(it.snippet.title),
        channel: channel.title,
        thumb: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || "",
      }));
    state.resultsMode = "channel";
    state.nextPageToken = null;
    el.resultsTitle.textContent = channel.title;
    el.resultsList.innerHTML = "";
    items.forEach((v) => el.resultsList.appendChild(makeVideoItem(v)));
    showScreen("results");
  } catch (err) {
    handleAccountError(err);
  } finally {
    setLoading(false);
  }
}

/** Videos marcados con "Me gusta". */
async function showLikedVideos() {
  setLoading(true);
  try {
    const data = await authFetch("videos", {
      part: "snippet",
      myRating: "like",
      maxResults: "15",
    });
    const items = (data.items || []).map((v) => ({
      id: v.id,
      title: decodeEntities(v.snippet.title),
      channel: decodeEntities(v.snippet.channelTitle),
      thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || "",
    }));
    state.resultsMode = "likes";
    state.nextPageToken = null;
    el.resultsTitle.textContent = "Me gusta";
    el.resultsList.innerHTML = "";
    items.forEach((v) => el.resultsList.appendChild(makeVideoItem(v)));
    if (!items.length) {
      showError("No hay videos con Me gusta en esta cuenta.");
      return;
    }
    showScreen("results");
  } catch (err) {
    handleAccountError(err);
  } finally {
    setLoading(false);
  }
}

/** Pinta los chips del bloque "Mi cuenta" según el estado de sesión. */
function renderAccountBlock() {
  el.accountBlock.hidden = !oauthClientId();
  if (!oauthClientId()) return;
  el.accountActions.innerHTML = "";
  const addChip = (label, onClick) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.setAttribute("data-focusable", "");
    chip.textContent = label;
    chip.addEventListener("click", onClick);
    el.accountActions.appendChild(chip);
  };
  if (isLoggedIn()) {
    addChip("📺 Suscripciones", showSubscriptions);
    addChip("❤ Me gusta", showLikedVideos);
    addChip("Salir", logout);
  } else {
    addChip("👤 Iniciar sesión con YouTube", startLogin);
  }
}

/* ============================================================
 * Teclado en pantalla (las gafas no tienen teclado físico)
 * ------------------------------------------------------------
 * Rejilla de teclas [data-focusable] navegable con los mismos
 * gestos que el resto de la app: swipes mueven el foco (con
 * salto de fila en vertical) y el pellizco pulsa la tecla.
 * Se usa para dos cosas: componer búsquedas ("search") y
 * escribir el código del dispositivo de destino ("code").
 * ============================================================ */
function buildKeyboard() {
  KB_ROWS.forEach((row, r) => {
    const rowEl = document.createElement("div");
    rowEl.className = "kb-row";
    row.forEach((key, c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kb-key";
      btn.setAttribute("data-focusable", "");
      btn.dataset.row = r;
      btn.dataset.col = c;
      btn.dataset.key = key;
      if (key === "␣") btn.classList.add("kb-wide");
      if (key === "OK") btn.classList.add("kb-ok");
      btn.textContent = key;
      btn.addEventListener("click", () => kbPress(key));
      rowEl.appendChild(btn);
    });
    el.kbRows.appendChild(rowEl);
  });
}

function openKeyboard(mode) {
  state.kbMode = mode;
  if (mode === "code") {
    el.kbLabel.textContent = "Código del otro dispositivo";
    state.kbText = localStorage.getItem(LS_TARGET_KEY) || "";
  } else {
    el.kbLabel.textContent = "Buscar en YouTube";
    state.kbText = "";
  }
  updateKbPreview();
  state.kbPhysical = false;
  el.keyboard.hidden = false;
  // Empezar con el foco en la primera letra (fila qwerty), no en los números
  refreshFocusables(10);
}

function closeKeyboard() {
  el.keyboard.hidden = true;
  state.pendingSend = null;
  refreshFocusables();
}

function updateKbPreview() {
  el.kbPreview.textContent = (state.kbText || "") + "▏";
}

function kbPress(key) {
  if (key === "⌫") {
    state.kbText = state.kbText.slice(0, -1);
  } else if (key === "␣") {
    state.kbText += " ";
  } else if (key === "✕") {
    closeKeyboard();
    return;
  } else if (key === "OK") {
    kbConfirm();
    return;
  } else {
    state.kbText += state.kbMode === "code" ? key.toUpperCase() : key;
  }
  updateKbPreview();
}

function kbConfirm() {
  const text = state.kbText.trim();
  if (state.kbMode === "search") {
    el.keyboard.hidden = true;
    if (text) {
      searchVideos(text);
    } else {
      refreshFocusables();
    }
  } else {
    // Modo código: validar, guardar y enviar el video pendiente
    if (text.length < 4) {
      el.kbLabel.textContent = "El código tiene al menos 4 caracteres";
      return;
    }
    const video = state.pendingSend;
    el.keyboard.hidden = true;
    state.pendingSend = null;
    localStorage.setItem(LS_TARGET_KEY, text.toUpperCase());
    refreshFocusables();
    if (video) publishToDevice(text.toUpperCase(), video);
  }
}

/** Navegación 2D dentro del teclado: dc = ±1 columna, dr = ±1 fila. */
function kbNav(dc, dr) {
  const current = state.focusables[state.focusIndex];
  if (!current?.dataset.key) return;
  let r = Number(current.dataset.row);
  let c = Number(current.dataset.col);
  if (dr) {
    r = Math.min(Math.max(r + dr, 0), KB_ROWS.length - 1);
    c = Math.min(c, KB_ROWS[r].length - 1); // ajustar a filas más cortas
  } else {
    const len = KB_ROWS[r].length;
    c = (c + dc + len) % len; // circular dentro de la fila
  }
  const target = el.kbRows.querySelector(`[data-row="${r}"][data-col="${c}"]`);
  const idx = state.focusables.indexOf(target);
  if (idx >= 0) {
    state.focusIndex = idx;
    applyFocus();
  }
}

/* ============================================================
 * Enviar / recibir videos entre dispositivos (teléfono ⇄ gafas)
 * ------------------------------------------------------------
 * Sin backend propio: se usa el servicio público ntfy.sh como
 * canal pub/sub. Cada dispositivo tiene un código aleatorio
 * (persistido en localStorage) y escucha su topic por SSE.
 * "Enviar" publica el video en el topic del código de destino.
 * Nota: solo viajan IDs y títulos de videos públicos de YouTube.
 * ============================================================ */
function getPairCode() {
  let code = localStorage.getItem(LS_PAIR_KEY);
  if (!code) {
    code = Array.from({ length: 6 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join("");
    localStorage.setItem(LS_PAIR_KEY, code);
  }
  return code;
}

function ntfyTopicUrl(code) {
  return NTFY_TOPIC_PREFIX + code.toLowerCase();
}

/** Escucha permanente: cualquier video publicado en el topic propio se reproduce. */
function startReceiver() {
  if (typeof EventSource === "undefined") return;
  try {
    const es = new EventSource(`${ntfyTopicUrl(getPairCode())}/sse`);
    es.onmessage = (e) => {
      try {
        const notif = JSON.parse(e.data);
        const video = JSON.parse(notif.message);
        if (video?.id && video?.title) {
          showToast("📲 Video recibido");
          playVideo(video);
        }
      } catch {
        /* mensaje ajeno o malformado: ignorar */
      }
    };
    // EventSource se reconecta solo tras cortes de red: no hace falta más
  } catch (err) {
    console.warn("[Racsotube] No se pudo iniciar el receptor:", err);
  }
}

/** Publica el video en el topic del código de destino. */
async function publishToDevice(code, video) {
  try {
    const res = await fetch(ntfyTopicUrl(code), {
      method: "POST",
      body: JSON.stringify({
        id: video.id,
        title: video.title,
        channel: video.channel,
        thumb: video.thumb,
      }),
    });
    showToast(res.ok ? `Enviado a ${code} ✓` : "No se pudo enviar");
  } catch {
    showToast("Sin conexión: no se pudo enviar");
  }
}

/** El botón 📲 del reproductor: pide/confirma el código y envía. */
function sendCurrentVideo() {
  const video = loadJSON(LS_VIDEOS_KEY)[0]; // el video en reproducción es el más reciente
  if (!video) return;
  state.pendingSend = video;
  openKeyboard("code");
}

let toastTimer = null;
function showToast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3000);
}

/* ============================================================
 * Entradas: teclado, táctil y SDK de Meta Wearables
 * ============================================================ */

/** Acciones abstractas: cualquier método de entrada termina aquí. */
const actions = {
  prev: () => moveFocus(-1),
  next: () => moveFocus(1),
  select: () => {
    // En el reproductor, "seleccionar" (pellizco/Enter/tap) alterna play/pausa
    // — salvo que el usuario haya movido el foco a un botón (←, 📲) o haya
    // una capa (error/teclado) abierta
    if (
      state.screen === "player" &&
      el.errorPanel.hidden &&
      !kbOpen() &&
      !state.playerNavigated
    ) {
      togglePlayback();
    } else {
      state.playerNavigated = false;
      selectFocused();
    }
  },
  back: () => goBack(),
};

function initKeyboardInput() {
  document.addEventListener("keydown", (e) => {
    // ---- Con el teclado en pantalla abierto, navegación 2D ----
    if (kbOpen()) {
      if (e.key === "ArrowLeft") { e.preventDefault(); kbNav(-1, 0); }
      else if (e.key === "ArrowRight") { e.preventDefault(); kbNav(1, 0); }
      else if (e.key === "ArrowUp") { e.preventDefault(); kbNav(0, -1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); kbNav(0, 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        // Si se escribió con teclado físico, Enter confirma; con gestos,
        // Enter (= pellizco) pulsa la tecla que tiene el foco
        if (state.kbPhysical && state.kbText.trim()) kbConfirm();
        else selectFocused();
      }
      else if (e.key === "Escape") { closeKeyboard(); }
      else if (e.key === "Backspace") { e.preventDefault(); kbPress("⌫"); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Escritura directa con teclado físico (escritorio/teléfono)
        e.preventDefault();
        state.kbPhysical = true;
        kbPress(e.key);
      }
      return;
    }

    switch (e.key) {
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        actions.prev();
        break;
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        actions.next();
        break;
      case "Enter":
        e.preventDefault();
        actions.select();
        break;
      case " ":
      case "Spacebar":
        // Barra espaciadora = seleccionar (algunos runtimes traducen así el tap)
        e.preventDefault();
        actions.select();
        break;
      case "Escape":
      case "Backspace":
        actions.back();
        break;
    }
  });
}

/**
 * Entrada táctil: swipes para navegar y tap para seleccionar.
 * IMPORTANTE: el tap se maneja aquí directamente (no se delega al evento
 * "click") porque algunos runtimes —incluidas las gafas— envían los eventos
 * touch sin generar después el click sintético, y el pellizco quedaría mudo.
 */
function initTouchInput() {
  let startX = 0, startY = 0;
  const THRESHOLD = 40;        // px mínimos para considerar swipe
  let suppressClicksUntil = 0; // evita doble activación tap + click sintético

  document.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;

    // ---- Tap (sin desplazamiento apreciable) = seleccionar ----
    if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) {
      const target = e.target.closest?.("[data-focusable]");
      e.preventDefault(); // suprime el click sintético que seguiría al tap
      if (target) {
        // Mover el foco al elemento tocado y activarlo
        const idx = state.focusables.indexOf(target);
        if (idx >= 0) {
          state.focusIndex = idx;
          applyFocus();
        }
        target.click();
      } else {
        actions.select(); // tap en el fondo: activar el elemento con foco
      }
      suppressClicksUntil = Date.now() + 400;
      return;
    }

    // ---- Swipe ----
    if (kbOpen()) {
      // Dentro del teclado los swipes navegan la rejilla en 2D
      if (Math.abs(dy) > Math.abs(dx)) kbNav(0, dy > 0 ? -1 : 1);
      else kbNav(dx > 0 ? 1 : -1, 0);
      return;
    }
    if (Math.abs(dy) > Math.abs(dx)) {
      dy > 0 ? actions.prev() : actions.next(); // vertical: mover foco
    } else if (dx > 0) {
      actions.back(); // a la derecha: volver
    }
  }, { passive: false });

  // Si a pesar del preventDefault el navegador genera el click sintético,
  // este guardián en fase de captura lo descarta para no activar dos veces.
  document.addEventListener("click", (e) => {
    if (Date.now() < suppressClicksUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);

  // Click de ratón/gesto en el fondo (fuera de cualquier elemento navegable):
  // también cuenta como "seleccionar", por si el runtime traduce el pellizco
  // a un click en el centro de la pantalla.
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("[data-focusable]")) actions.select();
  });
}

/**
 * Entrada del Meta Neural Band (EMG) y Cap Touch de la montura.
 *
 * IMPORTANTE: el SDK de Meta Wearables Web Apps está en developer preview y
 * sus nombres de eventos pueden cambiar. Por eso todo va detrás de
 * feature-detection: si window.MetaWearables no existe (navegador normal),
 * la app funciona igual con teclado/táctil. Ajusta los nombres de gestos
 * según la versión del SDK que documente
 * https://wearables.developer.meta.com/docs/develop/webapps/
 */
function initWearableInput() {
  if (!window.MetaWearables) return;

  // Mapeo tentativo gesto → acción (verificar con la doc del SDK actual):
  //   pinch (pellizco índice-pulgar)  → seleccionar
  //   swipe up / down (pulgar sobre el índice o Cap Touch) → mover foco
  //   double pinch / pinch con dedo medio → volver
  const gestureMap = {
    pinch: actions.select,
    tap: actions.select,          // tap en Cap Touch
    swipeup: actions.prev,
    swipedown: actions.next,
    swipeforward: actions.prev,   // deslizamiento en la patilla
    swipebackward: actions.next,
    doublepinch: actions.back,
    middlepinch: actions.back,
  };

  try {
    const input = window.MetaWearables.input || window.MetaWearables;
    if (typeof input.addEventListener === "function") {
      // Variante A: emisor de eventos con un evento genérico "gesture"
      input.addEventListener("gesture", (e) => {
        const name = String(e.gesture || e.type || "").toLowerCase();
        gestureMap[name]?.();
      });
      // Variante B: un evento por gesto
      Object.keys(gestureMap).forEach((name) => {
        input.addEventListener(name, gestureMap[name]);
      });
    }
    console.info("[Racsotube] SDK de Meta Wearables detectado: gestos activados.");
  } catch (err) {
    console.warn("[Racsotube] No se pudo inicializar la entrada del SDK de Meta:", err);
  }
}

/* ============================================================
 * Arranque
 * ============================================================ */
function init() {
  el.errorDismiss.addEventListener("click", hideError);
  el.loginCancel.addEventListener("click", cancelLogin);

  // El buscador es un botón (no un <input>: el runtime de las gafas
  // intercepta la activación de los campos de texto y el pellizco nunca
  // llega). Cualquier variante del pellizco lo activa como a un botón más.
  el.searchBtn.addEventListener("click", () => openKeyboard("search"));

  // Botones de volver (←) y de enviar a otro dispositivo (📲)
  document.querySelectorAll('[data-action="back"]').forEach((b) =>
    b.addEventListener("click", goBack)
  );
  el.sendBtn.addEventListener("click", sendCurrentVideo);

  // Avisar en cuanto se pierda la conexión
  window.addEventListener("offline", () =>
    showError("Se perdió la conexión a internet.")
  );

  buildKeyboard();
  el.pairCode.textContent = getPairCode();
  startReceiver();

  initKeyboardInput();
  initTouchInput();
  initWearableInput();

  renderHome();
  showScreen("home");
}

document.addEventListener("DOMContentLoaded", init);
