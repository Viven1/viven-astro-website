/* ============================================================
   VIVEN.CH — Shared behaviour (all pages)
   i18n EN/DE/ES · deferred Vimeo · video modal · HubSpot lazy ·
   consent-gated GA4 · reveal animations
   ============================================================ */
(function(){
'use strict';

/* ---------- Header scroll ---------- */
var header = document.querySelector('header.site');
function onScroll(){ if(header) header.classList.toggle('scrolled', window.scrollY > 20); }
onScroll();
window.addEventListener('scroll', onScroll, {passive:true});

/* ---------- Mobile menu ---------- */
var menuBtn = document.getElementById('menu-btn');
var mobileMenu = document.getElementById('mobile-menu');
if(menuBtn && mobileMenu){
  menuBtn.addEventListener('click', function(){
    var open = mobileMenu.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.style.overflow = open ? 'hidden' : '';
  });
  mobileMenu.querySelectorAll('a').forEach(function(a){
    a.addEventListener('click', function(){
      mobileMenu.classList.remove('open');
      document.body.style.overflow = '';
    });
  });
}

/* ---------- Smooth-scroll for in-page anchors ---------- */
document.querySelectorAll('a[href^="#"]').forEach(function(a){
  a.addEventListener('click', function(e){
    var id = a.getAttribute('href');
    if(!id || id.length < 2) return;
    var target = document.querySelector(id);
    if(!target) return;
    e.preventDefault();
    target.scrollIntoView({behavior:'smooth', block:'start'});
    history.replaceState(null, '', id);
  });
});

/* ---------- Reveal on scroll (con fallback: nunca dejar contenido invisible) ---------- */
var revealEls = [].slice.call(document.querySelectorAll('.reveal'));
function revealInView(){
  var h = window.innerHeight || document.documentElement.clientHeight;
  revealEls = revealEls.filter(function(el){
    var r = el.getBoundingClientRect();
    if(r.top < h - 40 && r.bottom > -80){ el.classList.add('in'); return false; }
    return true;
  });
}
if('IntersectionObserver' in window){
  var revealIO = new IntersectionObserver(function(entries){
    entries.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); revealIO.unobserve(e.target); } });
  },{threshold:.12, rootMargin:'0px 0px -40px 0px'});
  revealEls.forEach(function(el){ revealIO.observe(el); });
}
/* Fallback por si el IntersectionObserver no dispara (algunos entornos/navegadores):
   revela lo que ya está en viewport en carga y a medida que se scrollea. */
revealInView();
window.addEventListener('scroll', revealInView, {passive:true});
window.addEventListener('resize', revealInView, {passive:true});

/* ---------- Language (EN / DE / ES) ---------- */
var LANGS = ['en','de','es'];
function setLang(lang){
  if(LANGS.indexOf(lang) === -1) lang = 'en';
  document.documentElement.lang = lang;
  /* LCP: no reescribir lo que YA está bien. Antes esto reasignaba innerHTML a todos
     los elementos con data-<lang>, incluido el titular del hero — que ya venía con
     ese mismo texto en el HTML. Para el navegador reasignar innerHTML destruye el
     texto y lo vuelve a crear, así que el LCP se corría al momento en que corría
     este JS: PageSpeed móvil medía "descarga 0 ms, render delay 2.280 ms" y un LCP
     de 5,7 s sobre un texto que estaba disponible desde el primer byte. (13 ago 2026)
     Saltear cuando es idéntico es además más seguro: reasignar innerHTML mata los
     listeners de los hijos. */
  document.querySelectorAll('[data-' + lang + ']').forEach(function(el){
    var v = el.getAttribute('data-' + lang);
    if(el.innerHTML !== v) el.innerHTML = v;
  });
  document.querySelectorAll('[data-' + lang + '-ph]').forEach(function(el){
    el.setAttribute('placeholder', el.getAttribute('data-' + lang + '-ph'));
  });
  document.querySelectorAll('[data-' + lang + '-href]').forEach(function(el){
    el.setAttribute('href', el.getAttribute('data-' + lang + '-href'));
  });
  document.querySelectorAll('.lang button').forEach(function(b){
    b.classList.toggle('active', b.dataset.lang === lang);
  });
  /* keep <title> + meta description in sync when page provides them */
  var t = document.querySelector('title');
  if(t && t.getAttribute('data-' + lang)) document.title = t.getAttribute('data-' + lang);
  var d = document.querySelector('meta[name="description"]');
  if(d && d.getAttribute('data-' + lang)) d.setAttribute('content', d.getAttribute('data-' + lang));
  try{ localStorage.setItem('viven-lang', lang); }catch(e){}
  /* espejo en cookie: el Worker de "/" redirige server-side según esta preferencia */
  try{ document.cookie = 'viven-lang=' + lang + ';path=/;max-age=31536000;SameSite=Lax'; }catch(e){}
}
/* Páginas nuevas (/en/ /de/ /es/): el idioma lo fija la URL vía <html lang data-fixed-lang>.
   Solo aplicamos el idioma al contenido con data-* y NO hacemos switching client-side
   (el selector son enlaces que navegan a la otra URL). */
if(document.documentElement.hasAttribute('data-fixed-lang')){
  var fixed = (document.documentElement.lang || 'en').slice(0,2);
  setLang(LANGS.indexOf(fixed) !== -1 ? fixed : 'en');
  try{ localStorage.setItem('viven-lang', fixed); }catch(e){}   /* recordar para el redirect de "/" */
} else {
  /* Páginas viejas (blog, etc.): selector client-side + ?lang / localStorage / navegador */
  document.querySelectorAll('.lang button').forEach(function(b){
    b.addEventListener('click', function(){ setLang(b.dataset.lang); });
  });
  var urlLang = new URLSearchParams(window.location.search).get('lang');
  var saved = null;
  try{ saved = localStorage.getItem('viven-lang'); }catch(e){}
  var nav = (navigator.language || '').toLowerCase();
  var browserLang = nav.indexOf('de') === 0 ? 'de' : (nav.indexOf('es') === 0 ? 'es' : 'en');
  setLang(LANGS.indexOf(urlLang) !== -1 ? urlLang : (saved || browserLang));
}

/* ---------- Vimeo: hero background (deferred for LCP) ---------- */
var heroBg = document.querySelector('.hero-bg');
var heroId = heroBg && (heroBg.dataset.vimeo || '').trim();
var heroMp4 = heroBg && (heroBg.dataset.mp4 || '').trim();   /* self-hosted: autoplay instantáneo, iOS incluido */
/* Pedido explícito de Sebastián: el hero SIEMPRE debe autoplayear solo, sin
   tocar nada, en Safari incluido. Antes esta función bloqueaba el video entero
   (ni se cargaba) por señales que resultaron ser la causa real de "no
   autoplay" persistente pese a los fixes de gestos: (a) prefers-reduced-motion
   — si el visitante (o Sebastián en su propio Mac) tiene "Reducir movimiento"
   activado en Accesibilidad, el video NUNCA se cargaba, sin importar ningún
   reintento de play() más abajo — el bug no estaba ahí sino acá arriba;
   (b) effectiveType/deviceMemory son heurísticas de Chrome que no existen en
   Safari (navigator.connection es undefined ahí) pero SÍ bloqueaban Android
   de gama media/baja. Se deja solo el respeto a Data Saver (señal explícita y
   deliberada del usuario, no una heurística nuestra) — todo lo demás, siempre
   sí. */
function heroVideoAllowed(){
  var c = navigator.connection || {};
  if(c.saveData) return false;   /* Data Saver activo: única razón real para no cargar */
  return true;
}
function loadHeroVideo(){
  if((!heroId && !heroMp4) || heroBg.querySelector('.hero-video')) return;
  if(!heroVideoAllowed()) return;
  if(heroMp4){
    /* MP4 propio: <video> nativo — arranca al toque, sin player de Vimeo */
    var v = document.createElement('video');
    v.className = 'hero-video';
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('autoplay', '');
    v.preload = 'auto';
    v.src = heroMp4;
    /* fade-in: el video aparece suave sobre el póster. 'timeupdate' es respaldo de
       'playing' (algunos WebKit no disparan 'playing' de forma confiable). */
    v.addEventListener('playing', function(){ v.classList.add('on'); }, { once: true });
    var fadeChk = function(){ if(v.currentTime > 0){ v.classList.add('on'); v.removeEventListener('timeupdate', fadeChk); } };
    v.addEventListener('timeupdate', fadeChk);
    heroBg.insertBefore(v, heroBg.querySelector('.grain'));
    /* SAFARI/iOS: la heurística de autoplay rechaza seguido el play() programático
       (reporte de Sebastián: hero estático en Safari Y en mobile). Reintentamos:
       (a) cuando llega data, (b) diferido (la heurística puede aflojar post-carga),
       (c) al volver a la pestaña, (d) en el primer GESTO REAL del usuario.
       BUG previo: el retry escuchaba 'pointermove'/'scroll'/'touchstart' con
       {once:true} — en Safari esos NO cuentan como "user activation" para
       levantar el bloqueo de autoplay (solo click/touchend/mousedown/keydown sí).
       Como scroll ocurre solitos en mobile, el listener {once:true} se consumía
       de gratis y el video quedaba mudo para siempre, incluso ante un tap real
       después. Ahora solo gestos que SÍ otorgan activación, sin 'once' (persiste
       hasta que el video realmente arranque). */
    var tryPlay = function(){ if(v.paused){ var p = v.play(); if(p && p.catch) p.catch(function(){}); } };
    tryPlay();
    v.addEventListener('loadeddata', tryPlay, { once: true });
    v.addEventListener('canplaythrough', tryPlay, { once: true });
    setTimeout(tryPlay, 700);
    setTimeout(tryPlay, 2500);
    document.addEventListener('visibilitychange', function(){ if(!document.hidden) tryPlay(); });
    var gestos = ['touchend', 'pointerdown', 'mousedown', 'keydown', 'click'];
    var gestoPlay = function(){
      if(v.paused){ var p = v.play(); if(p && p.catch) p.catch(function(){}); }
      if(!v.paused) limpiarGestos();
    };
    function limpiarGestos(){ gestos.forEach(function(e){ window.removeEventListener(e, gestoPlay); }); }
    gestos.forEach(function(e){ window.addEventListener(e, gestoPlay, { passive: true }); });
    return;
  }
  var f = document.createElement('iframe');
  f.className = 'hero-video';
  f.src = 'https://player.vimeo.com/video/' + heroId + '?background=1&autoplay=1&loop=1&muted=1&playsinline=1&dnt=1';
  f.allow = 'autoplay; fullscreen';
  f.title = 'Viven showreel';
  f.loading = 'eager';
  f.fetchPriority = 'high';
  heroBg.insertBefore(f, heroBg.querySelector('.grain'));
}
/* Facade: cargamos el player de Vimeo (pesado + cookie de terceros) recién en la
   primera interacción del visitante — instantáneo para cualquiera que haga scroll o
   mueva el mouse, y sin penalizar el primer render ni la privacidad. */
(function armHeroVideo(){
  if(!heroBg || (!heroId && !heroMp4)) return;   /* mp4 propio sin data-vimeo también debe armarse */
  var done = false;
  var evs = ['pointermove', 'scroll', 'touchstart', 'keydown', 'wheel', 'click'];
  function go(){
    if(done) return; done = true;
    evs.forEach(function(e){ window.removeEventListener(e, go); });
    loadHeroVideo();   // el visitante YA interactuó — cargar sin esperar al idle
  }
  evs.forEach(function(e){ window.addEventListener(e, go, { once: true, passive: true }); });
  /* y si el visitante solo MIRA sin tocar nada: arrancar solo apenas termina de cargar
     la página (post-LCP, no afecta la métrica) — el hero se siente vivo siempre */
  function later(){
    if('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 1800 });
    else setTimeout(go, 1200);
  }
  if(document.readyState === 'complete') later();
  else window.addEventListener('load', later, { once: true });
})();

/* ---------- Carrusel de palabras del titular ----------
   Arranca DESPUÉS del load y con un respiro: el titular del hero es el elemento
   LCP de la home, así que no se toca hasta que la métrica ya se midió. Todas las
   palabras ya están en el HTML — esto solo mueve la clase .on.
   Vuelve a consultar el DOM en cada vuelta a propósito: setLang() reescribe el
   titular al cambiar de idioma, y si guardáramos referencias quedarían apuntando
   a nodos que ya no están en la página. Y si alguien pidió menos movimiento en su
   sistema, no rota: se queda en la primera palabra. */
(function rotWords(){
  var quieto = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(quieto) return;
  /* AUTO-CORRECTOR: no se guarda un indice. Se mira cual palabra esta visible AHORA,
     se apagan TODAS y se prende la siguiente. Con un indice guardado, cualquier
     desincronizacion (setLang reescribiendo el titular, o dos tickers) hacia que se
     apagara una palabra que no estaba prendida y quedaran dos encima de la otra —
     se veia "tarlsht." en vez de "trust.". Asi es imposible. */
  function tick(){
    document.querySelectorAll('.rot').forEach(function(slot){
      var ws = slot.querySelectorAll('.rot-w');
      if(ws.length < 2) return;
      var cur = 0;
      for(var a = 0; a < ws.length; a++) if(ws[a].classList.contains('on')) cur = a;
      for(var b = 0; b < ws.length; b++) { ws[b].classList.remove('on'); ws[b].classList.remove('out'); }
      /* la que estaba se va hacia arriba; la siguiente entra desde abajo */
      ws[cur].classList.add('out');
      ws[(cur + 1) % ws.length].classList.add('on');
      (function(saliente){
        setTimeout(function(){ saliente.classList.remove('out'); }, 460);
      })(ws[cur]);
    });
  }
  function arm(){ setInterval(tick, 2400); }
  if(document.readyState === 'complete') setTimeout(arm, 1200);
  else window.addEventListener('load', function(){ setTimeout(arm, 1200); }, { once: true });
})();

/* ---------- Video modal (shared) ---------- */
var modal = document.getElementById('video-modal');
var mount = document.getElementById('video-mount');
function openVideo(id, title, hash){
  if(!id || !modal) return false;
  /* tracking: qué video abrió esta sesión (para analytics + "videos vistos" por lead) */
  try{
    if(!/^(localhost|127\.|192\.168\.)/.test(location.hostname)){
      sbInsert('video_plays', { session_id: sessionStorage.getItem('viven-session') || 'no-storage', video_id: String(id), label: title || null, lang: document.documentElement.lang || null });
    }
  }catch(e){}
  var h = hash ? 'h=' + hash + '&' : '';   /* videos privados de Vimeo necesitan el token */
  vvVidHooked = false;   /* el player nuevo se suscribe a los eventos de progreso al estar ready */
  mount.innerHTML = '<iframe src="https://player.vimeo.com/video/' + id + '?' + h + 'autoplay=1&dnt=1&title=0&byline=0&portrait=0" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" title="' + (title || 'Viven video') + '"></iframe>';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden','false');
  document.body.style.overflow = 'hidden';
  return true;
}
function closeVideo(){
  if(!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden','true');
  mount.innerHTML = '';
  document.body.style.overflow = '';
}
if(modal){
  modal.querySelectorAll('[data-close]').forEach(function(el){ el.addEventListener('click', closeVideo); });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && modal.classList.contains('open')) closeVideo(); });
}

/* Showreel trigger (hero button) */
var showreelBtn = document.getElementById('showreel-btn');
if(showreelBtn) showreelBtn.addEventListener('click', function(e){
  e.preventDefault();
  if(!openVideo(heroId || showreelBtn.dataset.vimeo, 'Viven showreel')) location.hash = '#work';
});

/* Work tiles → modal. Los tiles <a> (case study) navegan por href, no abren modal. */
document.querySelectorAll('.work-tile').forEach(function(tile){
  if(tile.tagName === 'A') return;                 // case study tile: es un link, dejarlo pasar
  var id = (tile.dataset.vimeo || '').trim();
  if(!id){ tile.style.display = 'none'; return; }
  tile.addEventListener('click', function(){ openVideo(id, tile.dataset.label || 'Viven', (tile.dataset.hash || '').trim()); });
});
/* Grilla de proyectos: orden aleatorio de los videos (los case studies quedan primero) en cada
   carga → la página siempre parece nueva. Corre mientras los tiles están invisibles (reveal), sin flash. */
document.querySelectorAll('.work-grid[data-shuffle]').forEach(function(grid){
  /* mezcla los tiles → orden nuevo en cada carga. Los tiles con data-pin (los 3 case
     studies REALES) quedan SIEMPRE primeros — son la puerta de entrada para clientes. */
  var pinned = [].slice.call(grid.querySelectorAll('.work-tile[data-pin]'));
  var tiles = [].slice.call(grid.querySelectorAll('.work-tile:not([data-pin])'));
  for(var i = tiles.length - 1; i > 0; i--){ var j = Math.floor(Math.random() * (i + 1)); var t = tiles[i]; tiles[i] = tiles[j]; tiles[j] = t; }
  pinned.concat(tiles).forEach(function(el){ el.classList.remove('wt-feature'); grid.appendChild(el); });
  var first = pinned[0] || tiles[0];
  if(first) first.classList.add('wt-feature');  /* el destacado grande = el 1er case real */
});
document.querySelectorAll('.case .top').forEach(function(top){
  var id = (top.dataset.vimeo || '').trim();
  if(!id) return;
  top.classList.add('playable');
  var title = (top.querySelector('.client') || {}).textContent || 'Viven video';
  top.addEventListener('click', function(){ openVideo(id, title); });
});

/* ---------- Vimeo thumbnails (oEmbed, lazy) ---------- */
function loadVimeoThumb(tile){
  var id = (tile.dataset.vimeo || '').trim();
  var thumb = tile.querySelector('.wt-thumb');
  if(!id || !thumb || thumb.style.backgroundImage || thumb.querySelector('img')) return;
  var cb = 'vmb_' + id + '_' + Math.floor(Math.random() * 1e6);
  window[cb] = function(data){
    if(data && data.thumbnail_url && !thumb.querySelector('img')){
      var img = document.createElement('img');
      img.src = data.thumbnail_url;
      img.width = data.thumbnail_width || 800;
      img.height = data.thumbnail_height || 450;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = tile.dataset.label || 'Viven video';
      thumb.appendChild(img);
    }
    try{ delete window[cb]; }catch(e){}
  };
  var s = document.createElement('script');
  s.src = 'https://vimeo.com/api/oembed.json?url=https://vimeo.com/' + id + '&width=800&callback=' + cb;
  s.async = true;
  s.onerror = function(){ try{ delete window[cb]; }catch(e){} };
  document.head.appendChild(s);
}
var thumbIO = new IntersectionObserver(function(entries){
  entries.forEach(function(e){ if(e.isIntersecting){ loadVimeoThumb(e.target); thumbIO.unobserve(e.target); } });
},{rootMargin:'300px'});
document.querySelectorAll('.work-tile').forEach(function(t){ thumbIO.observe(t); });

/* ---------- Portfolio filters (projects page) ---------- */
var filterBar = document.querySelector('.filters');
if(filterBar){
  filterBar.querySelectorAll('button').forEach(function(btn){
    btn.addEventListener('click', function(){
      filterBar.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      var f = btn.dataset.filter;
      document.querySelectorAll('.work-tile').forEach(function(tile){
        var show = f === 'all' ? true
                 : f === 'case' ? tile.classList.contains('wt-case')
                 : (tile.dataset.cat || '').split(' ').indexOf(f) !== -1;
        tile.style.display = show ? '' : 'none';
        if(show) loadVimeoThumb(tile);
        // el tag muestra la categoría del filtro activo (evita ver "Brand" cuando filtrás "Social")
        var cat = tile.querySelector('.wt-cat');
        if(cat){
          var spans = cat.querySelectorAll('.cl');
          if(spans.length){
            var matched = false;
            spans.forEach(function(s){ var m = (f !== 'all' && f !== 'case') && s.dataset.c === f; s.hidden = !m; if(m) matched = true; });
            if(!matched){ spans.forEach(function(s, i){ s.hidden = i !== 0; }); }  // sin match → categoría primaria
          }
        }
      });
    });
  });
}

/* ---------- Lead form propio (guarda en Supabase → tabla leads) ---------- */
function renderLeadForm(mount){
  mount.innerHTML =
    '<form class="lead-form" novalidate>' +
      '<div class="row2">' +
        '<div class="field">' +
          '<label data-en=\'First name <span class="req">*</span>\' data-de=\'Vorname <span class="req">*</span>\' data-es=\'Nombre <span class="req">*</span>\'>First name <span class="req">*</span></label>' +
          '<input type="text" name="first_name" required maxlength="80" autocomplete="given-name" aria-label="First name" />' +
        '</div>' +
        '<div class="field">' +
          '<label data-en=\'Last name <span class="req">*</span>\' data-de=\'Nachname <span class="req">*</span>\' data-es=\'Apellido <span class="req">*</span>\'>Last name <span class="req">*</span></label>' +
          '<input type="text" name="last_name" required maxlength="80" autocomplete="family-name" aria-label="Last name" />' +
        '</div>' +
      '</div>' +
      '<div class="field">' +
        '<label data-en=\'Work email <span class="req">*</span>\' data-de=\'Gesch&auml;ftliche E-Mail <span class="req">*</span>\' data-es=\'Email de trabajo <span class="req">*</span>\'>Work email <span class="req">*</span></label>' +
        '<input type="email" name="email" required maxlength="200" autocomplete="email" aria-label="Work email" />' +
      '</div>' +
      '<div class="row2">' +
        '<div class="field">' +
          '<label data-en="Company" data-de="Unternehmen" data-es="Empresa">Company</label>' +
          '<input type="text" name="company" maxlength="120" autocomplete="organization" aria-label="Company" />' +
        '</div>' +
        '<div class="field">' +
          '<label data-en="Phone" data-de="Telefon" data-es="Tel&eacute;fono">Phone</label>' +
          '<input type="tel" name="phone" maxlength="40" autocomplete="tel" aria-label="Phone" />' +
        '</div>' +
      '</div>' +
      '<div class="field">' +
        '<label data-en="What are you working on?" data-de="Woran arbeiten Sie?" data-es="&iquest;En qu&eacute; est&aacute;s trabajando?">What are you working on?</label>' +
        '<textarea name="message" maxlength="4000" rows="4" aria-label="Your message"></textarea>' +
      '</div>' +
      /* honeypot: los bots lo completan, los humanos no lo ven */
      '<div class="hp-field" aria-hidden="true"><label>Website</label><input type="text" name="website" tabindex="-1" autocomplete="off" /></div>' +
      '<button type="submit" data-en="Send message" data-de="Nachricht senden" data-es="Enviar mensaje">Send message</button>' +
      '<p class="form-error" data-en="Something went wrong — please email us at info@viven.ch" data-de="Etwas ist schiefgelaufen — bitte schreiben Sie uns an info@viven.ch" data-es="Algo sali&oacute; mal — escr&iacute;benos a info@viven.ch">Something went wrong — please email us at info@viven.ch</p>' +
    '</form>' +
    '<div class="form-ok">' +
      '<div class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m5 13 4 4L19 7"/></svg></div>' +
      '<h3 data-en="Message sent!" data-de="Nachricht gesendet!" data-es="&iexcl;Mensaje enviado!">Message sent!</h3>' +
      '<p data-en="We&#39;ll reply within one business day." data-de="Wir antworten innerhalb eines Werktags." data-es="Respondemos en un d&iacute;a h&aacute;bil.">We&#39;ll reply within one business day.</p>' +
    '</div>';

  /* prueba social pegada al form (CRO): wordmarks — decide donde decide el visitante */
  var proof = document.createElement('div');
  proof.className = 'form-proof';
  proof.innerHTML = '<b data-en="Trusted by" data-de="Vertraut von" data-es="Conf\u00edan en nosotros">Trusted by</b> UBS \u00b7 Siemens \u00b7 Porsche \u00b7 ON \u00b7 FIFA \u00b7 KPMG' +
    ' <span class="fp-stars">\u2605 5.0</span> <span data-en="\u00b7 47+ Google reviews" data-de="\u00b7 47+ Google-Bewertungen" data-es="\u00b7 47+ rese\u00f1as en Google">\u00b7 47+ Google reviews</span>';
  mount.insertBefore(proof, mount.firstChild);
  var form = mount.querySelector('.lead-form');
  var okBox = mount.querySelector('.form-ok');
  var renderedAt = Date.now();
  /* ojo: form.name devuelve el atributo del <form>, NO un input llamado "name" */
  var fFirst = form.querySelector('[name="first_name"]');
  var fLast = form.querySelector('[name="last_name"]');
  var fEmail = form.querySelector('[name="email"]');
  var fMsg = form.querySelector('[name="message"]');
  var fCompany = form.querySelector('[name="company"]');
  var fPhone = form.querySelector('[name="phone"]');
  var fHp = form.querySelector('[name="website"]');

  form.addEventListener('submit', function(e){
    e.preventDefault();
    form.classList.remove('has-error');
    var first = fFirst.value.trim();
    var last = fLast.value.trim();
    var email = fEmail.value.trim();
    if(!first || !last || !email || !fEmail.checkValidity()){ form.reportValidity(); return; }
    /* anti-spam: honeypot lleno o envío en <3s = bot → éxito falso, sin guardar */
    if(fHp.value || (Date.now() - renderedAt) < 3000){
      form.style.display = 'none'; okBox.classList.add('show');
      return;
    }
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    var extra = window.vivenAttribution ? window.vivenAttribution() : null;
    var row = {
      name: first + ' ' + last,   /* nombre completo (compatibilidad) */
      first_name: first,
      last_name: last,
      email: email,
      company: (fCompany && fCompany.value.trim()) || null,
      phone: (fPhone && fPhone.value.trim()) || null,
      message: fMsg.value.trim() || null,
      form_path: location.pathname   /* en qué página convirtió (servicio > contact) */
    };
    var abTags = window.vvAbTags ? window.vvAbTags() : window.__vvAB;   /* variantes A/B que vio, en esta u otras páginas */
    if(abTags) row.ab = abTags;
    if(extra){
      row.session_id = extra.session_id;
      row.lang = extra.lang;
      if(extra.attrib){
        row.channel = extra.attrib.channel;
        row.gclid = extra.attrib.gclid;
        row.utm_source = extra.attrib.utm_source;
        row.utm_campaign = extra.attrib.utm_campaign;
        row.landing_path = extra.attrib.landing_path;
        if(extra.attrib.ref_code) row.referred_by = extra.attrib.ref_code;
      }
    }
    /* Además de Supabase, mandamos a HubSpot (CRM + automations) vía su
       API pública de submissions — sin cargar el widget pesado. Best-effort:
       si HubSpot falla, el lead igual queda en nuestro dashboard. */
    hubspotSubmit(first, last, email, fMsg.value.trim(), (fCompany && fCompany.value.trim()) || '-');

    sbInsertLead(row).then(function(r){
      if(r && r.ok){
        /* conversión → thank-you page en el idioma del visitante
           (ahí se dispara el evento de Google Ads / GA4) */
        var dest = {en: '/thank-you/', de: '/danke/', es: '/gracias/'};
        window.location.href = dest[document.documentElement.lang] || dest.en;
      }else{
        btn.disabled = false;
        form.classList.add('has-error');
      }
    });
  });
}
/* Envío a HubSpot (Forms Submissions API, pública, sin auth ni widget).
   Los nombres de campo deben coincidir con el form de HubSpot (firstname/lastname/email/message). */
function hubspotSubmit(first, last, email, message, company){
  try{
    var hutk = (document.cookie.match(/hubspotutk=([^;]+)/) || [])[1];
    var body = {
      fields: [
        { name: 'firstname', value: first },
        { name: 'lastname', value: last },
        { name: 'email', value: email },
        { name: 'company', value: company || '-' },   /* REQUERIDO por el form de HubSpot — sin esto rechazaba TODO */
        { name: 'message', value: message || '' }
      ],
      context: { pageUri: location.href, pageName: document.title }
    };
    if(hutk) body.context.hutk = hutk;
    fetch('https://api.hsforms.com/submissions/v3/integration/submit/4084680/994b80e1-84c2-42de-a5a1-ea2145608d76', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), keepalive: true
    }).catch(function(){});
  }catch(e){}
}
document.querySelectorAll('.lead-form-mount').forEach(function(m){ renderLeadForm(m); });

/* ---------- Slide-in de la calculadora (CRO) ----------
   Al 60% de scroll en páginas de contenido/servicio: invitación discreta a la
   calculadora. Una vez por sesión, cerrable, nunca en las páginas donde no
   aporta (calculadora misma, thank-you, book, dashboard, propuestas). */
(function(){
  var path = location.pathname;
  if(/calculator|kosten-rechner|calculadora|thank-you|danke|gracias|dashboard|proposal|book/.test(path)) return;
  try{ if(sessionStorage.getItem('vv_calc_slidein')) return; }catch(e){}
  var lang = (document.documentElement.lang || 'en').slice(0,2);
  var T = {
    en: { t: 'Curious what your video would cost?', s: '5 quick questions — free, no obligation.', b: 'Try the calculator →', u: '/en/video-cost-calculator/' },
    de: { t: 'Was würde Ihr Video kosten?', s: '5 kurze Fragen — gratis und unverbindlich.', b: 'Zum Kostenrechner →', u: '/de/videoproduktion-kosten-rechner/' },
    es: { t: '¿Querés saber cuánto costaría tu video?', s: '5 preguntas rápidas — gratis y sin compromiso.', b: 'Probar la calculadora →', u: '/es/calculadora-costos-video/' }
  };
  var t = T[lang] || T.en;
  var shown = false;
  function maybeShow(){
    if(shown) return;
    var h = document.documentElement.scrollHeight - window.innerHeight;
    if(h < 400 || window.scrollY / h < 0.6) return;
    shown = true;
    window.removeEventListener('scroll', maybeShow);
    try{ sessionStorage.setItem('vv_calc_slidein', '1'); }catch(e){}
    /* si estamos en una service page, el link entra con el tipo preseleccionado */
    var typeMap = { 'brand-video': 'brand', 'product-video': 'product', 'employer-branding': 'eb', 'how-to-video': 'howto', 'social-media-video': 'social', 'corporate-video': 'corporate' };
    var tKey = null;
    for (var k in typeMap){ if (path.indexOf('/services/' + k) !== -1){ tKey = typeMap[k]; break; } }
    /* páginas de localización (Basel/Genf/Lausanne/Zürich) y production services → preset corporate */
    if(!tKey){
      var localMap = {
        '/en/video-production-basel': 'corporate', '/en/video-production-geneva': 'corporate', '/en/video-production-lausanne': 'corporate', '/en/video-production-zurich': 'corporate', '/en/video-production-services-zurich': 'corporate',
        '/de/videoproduktion-basel': 'corporate', '/de/videoproduktion-genf': 'corporate', '/de/videoproduktion-lausanne': 'corporate', '/de/videoproduktion-zuerich': 'corporate', '/de/produktionsservices-schweiz': 'corporate',
        '/es/produccion-de-video-basilea': 'corporate', '/es/produccion-de-video-ginebra': 'corporate', '/es/produccion-de-video-lausana': 'corporate', '/es/produccion-de-video-zurich': 'corporate', '/es/servicios-de-produccion-audiovisual-suiza': 'corporate'
      };
      for (var k2 in localMap){ if (path.indexOf(k2) !== -1){ tKey = localMap[k2]; break; } }
    }
    var calcUrl = t.u + (tKey ? '?type=' + tKey : '');
    var box = document.createElement('div');
    box.className = 'vv-slidein';
    box.innerHTML = '<button class="vv-slidein-x" aria-label="Close">&times;</button>' +
      '<b>' + t.t + '</b><span>' + t.s + '</span>' +
      '<a class="btn btn-primary" href="' + calcUrl + '">' + t.b + '</a>';
    /* si el banner de cookies o la sticky-cta ("Start a project", mobile) están
       visibles, apilarse arriba de lo que sea más alto — si no, tapaba/lo tapaban */
    var extraBottom = 0;
    var cbar = document.getElementById('cookie-bar');
    if(cbar && cbar.offsetHeight) extraBottom = cbar.offsetHeight + 16;
    var stickyCta = document.querySelector('.sticky-cta');
    if(stickyCta && getComputedStyle(stickyCta).display !== 'none'){
      extraBottom = Math.max(extraBottom, stickyCta.offsetHeight + 16);
    }
    if(extraBottom) box.style.bottom = extraBottom + 'px';
    document.body.appendChild(box);
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ box.classList.add('in'); }); });
    box.querySelector('.vv-slidein-x').addEventListener('click', function(){ box.classList.remove('in'); setTimeout(function(){ box.remove(); }, 350); });
  }
  window.addEventListener('scroll', maybeShow, {passive:true});
})();

/* Lead magnet con gate REAL: el PDF vive en un bucket privado — la función
   magnet-download crea el lead server-side y devuelve una URL firmada de
   5 min. Sin email no hay link (el archivo no tiene URL pública). */
document.querySelectorAll('.lm-gate').forEach(function(box){
  var form = box.querySelector('.lm-gate-form');
  if(!form) return;
  /* el título parece accionable (señal de rage click en /tools/): clickearlo
     lleva el foco al campo de email en vez de no hacer nada */
  var lmTitle = box.querySelector('.lm-gate-copy h2');
  if(lmTitle){
    lmTitle.style.cursor = 'pointer';
    lmTitle.addEventListener('click', function(){
      var inp = form.querySelector('input[type="email"]');
      if(inp){ inp.focus(); inp.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    });
  }
  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    var inp = form.querySelector('input[type="email"]');
    var email = (inp.value || '').trim();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ inp.focus(); return; }
    var btn = form.querySelector('button'); if(btn.disabled) return; btn.disabled = true;
    var extra = window.vivenAttribution ? window.vivenAttribution() : null;
    /* la casilla del newsletter es la ÚNICA señal de consentimiento explícito
       que tenemos de esta persona: viaja al servidor y queda registrada ahí.
       Sin tildar no pasa nada — el PDF se manda igual. */
    var nlBox = box.querySelector('.lm-gate-nl input[type="checkbox"]');
    /* el texto que la persona vio al lado de la casilla viaja con el pedido:
       es lo que convierte una fecha en una prueba de consentimiento */
    var nlTxt = box.querySelector('.lm-gate-nl span');
    var body = { email: email, magnet: box.dataset.magnet || '', lang: (document.documentElement.lang || 'en').slice(0,2), form_path: location.pathname, newsletter: !!(nlBox && nlBox.checked) };
    if (body.newsletter && nlTxt) body.nl_text = (nlTxt.textContent || '').trim();
    if(extra){
      body.session_id = extra.session_id;
      if(extra.attrib){ body.channel = extra.attrib.channel; body.utm_source = extra.attrib.utm_source; body.landing_path = extra.attrib.landing_path; }
    }
    window.sbCallFunction('magnet-download', body).then(function(res){
      if(res && res.ok){
        if(window.vvFunnel) window.vvFunnel('magnet', 1, 'email_submitted');
        /* lead del magnet: tampoco pasa por /thank-you/ — contarlo en GA4/Ads */
        track('generate_lead', {method: 'lead_magnet', page: location.pathname});
        form.hidden = true;
        var d = box.querySelector('.lm-gate-done'); if(d) d.hidden = false;
        /* descarga inmediata Y mail con el link: el que puso una dirección
           falsa igual se lleva el PDF, y el que la puso bien lo tiene también
           en la casilla, que es lo que hace que abra los próximos. */
        if(res.url){
          var a = document.createElement('a');
          a.href = res.url; a.download = '';
          document.body.appendChild(a); a.click(); a.remove();
        }
      } else {
        btn.disabled = false;
      }
    });
  });
});

/* Newsletter del footer: captura de baja fricción (solo email) → lead con
   source 'newsletter'. Usa el mismo insert resiliente que el form principal. */
document.querySelectorAll('[data-nl] .nl-form').forEach(function(form){
  form.addEventListener('submit', function(ev){
    ev.preventDefault();
    var inp = form.querySelector('input[type="email"]');
    var email = (inp.value || '').trim();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ inp.focus(); return; }
    var btn = form.querySelector('button'); btn.disabled = true;
    var extra = window.vivenAttribution ? window.vivenAttribution() : null;
    var row = { name: '', first_name: '', email: email, message: 'Newsletter signup', form_path: location.pathname };   /* el origen va en message — leads.source no existe */
    if(extra){
      row.session_id = extra.session_id;
      row.lang = extra.lang;
      if(extra.attrib){ row.channel = extra.attrib.channel; row.utm_source = extra.attrib.utm_source; row.landing_path = extra.attrib.landing_path; }
    }
    /* también a HubSpot — pedido 2026-07-28: todo lead de viven.ch sincronizado en ambos */
    hubspotSubmit('', '', email, 'Newsletter signup', '-');
    sbInsertLead(row).then(function(res){
      var box = form.closest('[data-nl]');
      if(res && res.ok){
        form.hidden = true; var d = box.querySelector('.nl-done'); if(d) d.hidden = false;
        /* 👋 email de bienvenida en SU idioma (EN/DE/ES), al instante. Antes acá
           no llegaba nada hasta la edición mensual siguiente — hasta 30 días de
           silencio después de un "estás en la lista". Va DESPUÉS del insert y es
           best-effort a propósito: si la function está caída, la suscripción ya
           quedó hecha y el visitante no ve ningún error. El interruptor (arranca
           APAGADO) y el candado contra duplicados viven del lado del servidor
           (SQL 0130), no acá: desde el sitio siempre se llama igual. */
        if(window.sbCallFunction){
          window.sbCallFunction('newsletter-welcome', {
            email: email,
            lang: ((row.lang || document.documentElement.lang || 'en') + '').slice(0, 2),
            form_path: location.pathname
          });
        }
        /* lead real (fila en leads + HubSpot) que tampoco pasa por /thank-you/ —
           sin esto la suscripción al newsletter es invisible en GA4 y en Ads */
        track('generate_lead', {method: 'newsletter', page: location.pathname});
      }
      else { btn.disabled = false; }
    });
  });
});
/* el idioma ya se aplicó al cargar — re-aplicar sobre el formulario recién montado */
if(document.querySelector('.lead-form')) setLang(document.documentElement.lang || 'en');

/* CTA "Projekt starten": si la página YA tiene formulario, scrollear hasta él en vez
   de ir a /contact — así la conversión ocurre en la página del servicio y sabemos
   exactamente qué página convirtió (mejor atribución que "todos convierten en contact"). */
(function(){
  var mount = document.querySelector('.lead-form-mount');
  if(!mount) return;
  document.querySelectorAll('.sticky-cta a, header.site .btn-primary, .mobile-menu .btn-primary').forEach(function(a){
    a.addEventListener('click', function(e){
      e.preventDefault();
      mount.scrollIntoView({behavior: 'smooth', block: 'start'});
      var f = mount.querySelector('input[name="first_name"]');
      if(f) setTimeout(function(){ try{ f.focus({preventScroll: true}); }catch(_){ } }, 650);
    });
  });
})();

/* ---------- Lead conversion tracking (GA4, consent-gated: no-ops until gtag exists) ----------
   Cada evento sale por dos vías:
   1) gtag('event', ...) → GA4 directo (el config de GA vive en loadGA, con consentimiento).
   2) dataLayer.push({event: name, ...params}) → GTM. La vía gtag empuja un objeto
      `arguments` ({0:'event',1:'generate_lead',...}), que NO es un Custom Event trigger
      confiable en GTM; con el push explícito la agencia puede disparar los tags de
      conversión de Google Ads sobre {event:'generate_lead', method:'calculator'|...}.
   OJO: GA4 ya recibe estos eventos por la vía 1 — un tag GA4 en GTM sobre el mismo
   evento los contaría dos veces. El push es para los tags de Ads, no para GA4. */
function track(name, params){
  var p = params || {};
  if(typeof window.gtag === 'function') window.gtag('event', name, p);
  try{
    window.dataLayer = window.dataLayer || [];
    var msg = {event: name};
    for(var k in p){ if(Object.prototype.hasOwnProperty.call(p, k)) msg[k] = p[k]; }
    window.dataLayer.push(msg);
  }catch(_){ }
}
/* Meeting booking click → book_call */
document.querySelectorAll('a.book-call').forEach(function(a){
  a.addEventListener('click', function(){ track('book_call', {method: 'hubspot_meetings'}); });
});
/* Phone / email clicks → contact_click */
document.querySelectorAll('a[href^="tel:"], a[href^="mailto:"]').forEach(function(a){
  a.addEventListener('click', function(){
    track('contact_click', {method: a.getAttribute('href').indexOf('tel:') === 0 ? 'phone' : 'email'});
  });
});

/* ---------- Testimonial slider (scroll nativo: rueda, trackpad y dedo) ----------
   Auto-rota solo cuando está visible y nadie interactúa; los dots siguen el scroll. */
document.querySelectorAll('.review-slider').forEach(function(slider){
  var track = slider.querySelector('.review-track');
  var slides = track.children;
  if(slides.length < 2) return;
  var dotsWrap = slider.parentElement.querySelector('.review-dots');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dots = [];

  function step(){ return slides[0].getBoundingClientRect().width + 22; }
  function perView(){ return Math.max(1, Math.round(slider.clientWidth / slides[0].getBoundingClientRect().width)); }
  function maxIdx(){ return Math.max(0, slides.length - perView()); }
  function cur(){ return Math.min(maxIdx(), Math.round(slider.scrollLeft / step())); }
  function paint(){ var i = cur(); dots.forEach(function(dot, x){ dot.classList.toggle('active', x === i); }); }
  function goTo(n){ var m = maxIdx(); n = n < 0 ? m : (n > m ? 0 : n); slider.scrollTo({left: n * step(), behavior: reduced ? 'auto' : 'smooth'}); }
  function next(){ goTo(cur() >= maxIdx() ? 0 : cur() + 1); }

  if(dotsWrap){
    for(var d = 0; d <= maxIdx(); d++){
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('aria-label', 'Review ' + (d + 1));
      (function(idx){ b.addEventListener('click', function(){ goTo(idx); rearm(); }); })(d);
      dotsWrap.appendChild(b); dots.push(b);
    }
  }

  var delay = parseInt(slider.dataset.autoplay, 10) || 5000;
  var timer = null, visible = false, hold = null;
  function play(){ if(reduced || timer || !visible) return; timer = setInterval(next, delay); }
  function stop(){ if(timer){ clearInterval(timer); timer = null; } }
  function rearm(){ stop(); clearTimeout(hold); hold = setTimeout(play, delay); }

  slider.addEventListener('scroll', function(){ window.requestAnimationFrame(paint); }, { passive: true });
  /* cualquier interacción (rueda, trackpad, dedo, click) pausa; retoma solo */
  ['wheel', 'pointerdown', 'touchstart'].forEach(function(ev){
    slider.addEventListener(ev, function(){ stop(); rearm(); }, { passive: true });
  });
  paint();
  if('IntersectionObserver' in window){
    new IntersectionObserver(function(es){
      visible = es[0].isIntersecting;
      if(visible) play(); else stop();
    }, { threshold: 0.25 }).observe(slider);
  } else { visible = true; play(); }
});

/* ---------- Year ---------- */
var yearEl = document.getElementById('year');
if(yearEl) yearEl.textContent = new Date().getFullYear();

/* ---------- Cookie consent + GA4 (consent-gated) ---------- */
var GA_ID = 'G-6X7K72FXMM';
function loadGA(){
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', GA_ID);
}
/* Clarity no tiene noción propia de Consent Mode (no lee gtag) — a diferencia de
   GTM/GA4, si no la gateamos acá arranca a grabar sesiones igual. Por eso vive
   acá, junto a loadGA(), y no en el loader incondicional de Base.astro. */
function loadClarity(){
  (function(c,l,a,r,i,t,y){
    c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
    t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
    y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
  })(window, document, "clarity", "script", "ifp27judw5");
}
/* HubSpot: SIN este script la cookie `hubspotutk` nunca se crea, y sin esa cookie
   HubSpot no puede atribuir de dónde vino el lead — lo marca como "Offline
   Sources" aunque haya llegado de Google Ads. Es la causa que reportó la agencia
   el 25/08/2026: 6 leads de Google, ninguno como Paid Search.
   El código de los formularios YA buscaba la cookie y la mandaba si existía; lo
   que faltaba era el script que la crea.
   Va acá y no en el <head> a propósito: es una cookie de seguimiento de terceros,
   así que carga solo con consentimiento, igual que GA4 y Clarity. Consecuencia
   honesta: quien rechace las cookies va a seguir apareciendo como Offline, y eso
   no se puede arreglar por código. */
function loadHubSpot(){
  if(document.getElementById('hs-script-loader')) return;
  var t = document.createElement('script');
  t.id = 'hs-script-loader'; t.async = true; t.defer = true;
  t.src = 'https://js.hs-scripts.com/4084680.js';
  document.head.appendChild(t);
}

/* gtag/dataLayer ya vienen inicializados por el bloque de Consent Mode default en
   Base.astro <head> — esto solo actualiza la señal para que GTM/Ads la respeten. */
function grantConsent(){
  if(typeof gtag !== 'function') return;
  gtag('consent', 'update', {
    'ad_storage': 'granted',
    'analytics_storage': 'granted',
    'ad_user_data': 'granted',
    'ad_personalization': 'granted'
  });
}
var consent = null;
try{ consent = localStorage.getItem('viven-cookie'); }catch(e){}
if(consent === 'accepted'){ grantConsent(); loadGA(); loadClarity(); loadHubSpot(); }
if(consent === null){
  var bar = document.createElement('div');
  bar.id = 'cookie-bar';
  /* link a la privacy del idioma actual (el path viejo /privacy-policy/ era un 301 a /en/) */
  var privLang = (document.documentElement.lang || 'en').slice(0,2);
  if(['en','de','es'].indexOf(privLang) === -1) privLang = 'en';
  bar.innerHTML =
    '<p>Wir verwenden Cookies für Analysezwecke. / We use cookies for analytics. / Usamos cookies con fines analíticos. ' +
    '<a href="/' + privLang + '/privacy-policy/">Privacy</a></p>' +
    '<div class="cookie-btns">' +
    '<button id="cookie-decline">Decline</button>' +
    '<button id="cookie-accept">Accept</button>' +
    '</div>';
  document.body.appendChild(bar);
  document.getElementById('cookie-accept').onclick = function(){
    try{ localStorage.setItem('viven-cookie','accepted'); }catch(e){}
    bar.remove();
    grantConsent();
    loadGA();
    loadClarity();
    loadHubSpot();
  };
  document.getElementById('cookie-decline').onclick = function(){
    try{ localStorage.setItem('viven-cookie','declined'); }catch(e){}
    bar.remove();
  };
}

/* ---------- Conversión: llegada a una thank-you page ----------
   Aquí es donde Google Ads / GA4 registran el lead. El evento solo
   dispara si hay consentimiento de cookies (gtag existe). En Supabase
   la conversión se cuenta SIEMPRE (pageview de /thank-you|/danke|/gracias). */
if(/^\/(thank-you|danke|gracias)\/?$/.test(location.pathname)){
  track('generate_lead', {method: 'lead_form', page: location.pathname});
}

/* ---------- First-party analytics → Supabase (tabla pageviews) ----------
   Usa la API REST con fetch (0 KB de librerías). La key es la "publishable"
   de Supabase: es pública por diseño y RLS solo permite INSERT. */
var SB_URL = 'https://lumoevaotokgqnpybkyf.supabase.co';
var SB_KEY = 'sb_publishable_ORGL5_FNZTXcGKwvjs-ymw_Y8DV_4ca';
/* ---------- modo no-track del equipo ----------
   viven.ch/?viven-notrack=1 → este navegador deja de contar (pageviews, videos,
   A/B) para siempre; ?viven-notrack=0 lo reactiva. Los LEADS nunca se bloquean. */
try{
  var vvnp = new URLSearchParams(location.search);
  if(vvnp.get('viven-notrack') === '1'){ localStorage.setItem('vv_notrack', '1'); console.log('[viven] analytics OFF en este navegador'); }
  if(vvnp.get('viven-notrack') === '0'){ localStorage.removeItem('vv_notrack'); console.log('[viven] analytics ON'); }
}catch(e){}

function sbInsert(table, row){
  if(table !== 'leads'){ try{ if(localStorage.getItem('vv_notrack') === '1') return Promise.resolve(); }catch(e){} }
  return fetch(SB_URL + '/rest/v1/' + table, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(row),
    keepalive: true
  }).catch(function(){});
}

/* ---------- A/B testing (definido en el dashboard → tabla ab_tests) ----------
   La variante B se aplica client-side; el split vive en localStorage por test.
   Exposiciones → ab_hits (tabla propia: NO toca pageviews); el lead se taggea
   con window.__vvAB para medir conversión por variante. */
window.__vvAB = '';
function vvAbApply(changes){
  (changes || []).forEach(function(c){
    try{
      var els = document.querySelectorAll(c.sel);
      var el = els[c.idx || 0];
      if(!el) return;
      if(c.type === 'text') el.textContent = c.to;
      else if(c.type === 'html') el.innerHTML = c.to;
      else if(c.type === 'src') el.src = c.to;
      else if(c.type === 'href') el.href = c.to;
      else if(c.type === 'attr' && c.name) el.setAttribute(c.name, c.to);
    }catch(e){}
  });
}
(function vvAbInit(){
  try{
    var path = location.pathname;
    fetch(SB_URL + '/rest/v1/ab_tests?select=id,split_pct,status,changes&url_path=eq.' + encodeURIComponent(path) + '&status=in.(running,done_b)', {
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
    }).then(function(r){ return r.ok ? r.json() : []; }).then(function(tests){
      if(!tests || !tests.length) return;
      var force = null;
      try{ var fm = (new URLSearchParams(location.search).get('vvab') || '').match(/^(\d+):(a|b)$/); if(fm) force = { id: +fm[1], b: fm[2] }; }catch(e){}
      var tags = [];
      var run = function(){
        tests.forEach(function(t){
          var bucket = 'b';
          if(force && force.id === t.id){
            if(force.b === 'b') vvAbApply(t.changes);
            return;   /* preview forzado: ni sorteo ni exposición */
          }
          if(t.status === 'running'){
            var k = 'vv_ab_' + t.id;
            bucket = null;
            try{ bucket = localStorage.getItem(k); }catch(e){}
            if(bucket !== 'a' && bucket !== 'b'){
              bucket = (Math.random() * 100 < (Number(t.split_pct) || 50)) ? 'b' : 'a';
              try{ localStorage.setItem(k, bucket); }catch(e){}
            }
            tags.push(t.id + ':' + bucket);
            sbInsert('ab_hits', { test_id: t.id, bucket: bucket, session_id: (window.__vvSid || null), path: path });
          }
          if(bucket === 'b') vvAbApply(t.changes);
        });
        window.__vvAB = tags.join(',');
        /* atribución CROSS-PÁGINA (hallazgo de la auditoría A/B): __vvAB vivía solo en
           memoria de la página testeada — si el visitante veía la variante acá y
           convertía en OTRA página (contact, calculadora), el lead quedaba sin tag y
           la conversión de la variante se subcontaba. Persistimos los tags y el form
           los levanta desde cualquier página. */
        try{
          if(tags.length){
            var prev = {};
            try{ prev = JSON.parse(localStorage.getItem('vv_ab_tags') || '{}'); }catch(e){}
            tags.forEach(function(tg){ var p = tg.split(':'); prev[p[0]] = p[1]; });
            localStorage.setItem('vv_ab_tags', JSON.stringify(prev));
          }
        }catch(e){}
      };
      if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
      /* anti-carrera: si el swap de idioma pisa la variante, la re-aplicamos.
         done_b (ganador desplegado) también se re-aplica: no depende del sorteo */
      setTimeout(run2, 700);
      function run2(){ tests.forEach(function(t){ if(t.status === 'done_b'){ vvAbApply(t.changes); return; } var b2 = force && force.id === t.id ? force.b : (function(){ try{ return localStorage.getItem('vv_ab_' + t.id); }catch(e){ return null; } })(); if(b2 === 'b') vvAbApply(t.changes); }); }
    }).catch(function(){});
  }catch(e){}
})();
/* tags A/B completos para atribuir la conversión: lo visto en ESTA página (memoria)
   + lo visto en páginas anteriores (localStorage) — así el lead queda taggeado aunque
   convierta en una página distinta a la del test */
window.vvAbTags = function(){
  var parts = (window.__vvAB || '') ? window.__vvAB.split(',') : [];
  try{
    var st = JSON.parse(localStorage.getItem('vv_ab_tags') || '{}');
    var seen = {};
    parts.forEach(function(t){ seen[t.split(':')[0]] = true; });
    Object.keys(st).forEach(function(id){ if(!seen[id]) parts.push(id + ':' + st[id]); });
  }catch(e){}
  return parts.join(',');
};


/* Insert de lead a prueba de fallos: si a la tabla le falta una columna nueva
   (p.ej. 'phone' antes de correr el SQL), la saca y reintenta — así NUNCA se
   pierde un lead por un desajuste de esquema. Devuelve {ok:true|false}. */
function sbInsertLead(row){
  function attempt(r, depth){
    return fetch(SB_URL + '/rest/v1/leads', {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(r),
      keepalive: true
    }).then(function(res){
      if(res.ok) return {ok:true};
      if(depth >= 6) return {ok:false};
      return res.text().then(function(t){
        var m = /Could not find the '([^']+)' column|column "?([a-z_]+)"? of relation .* does not exist/i.exec(t || '');
        var col = m && (m[1] || m[2]);
        if(col && Object.prototype.hasOwnProperty.call(r, col)){
          var copy = {}; for(var k in r){ if(k !== col) copy[k] = r[k]; }
          return attempt(copy, depth + 1);
        }
        return {ok:false};
      }).catch(function(){ return {ok:false}; });
    }, function(){ return {ok:false}; });
  }
  return attempt(row, 0);
}
window.sbInsertLead = sbInsertLead;   /* expuesto para la calculadora de presupuesto (todo site.js vive en un IIFE) */
/* Token de seguimiento de HubSpot. Es lo que conecta este envío con la sesión de
   navegación donde quedó registrado el origen (Google Ads, orgánico, etc.). Sin
   él, HubSpot clasifica el contacto como "Offline Sources". Devuelve null si la
   persona no aceptó cookies — ahí no hay nada que pasar y está bien así. */
window.vvHutk = function(){
  try{ return (document.cookie.match(/hubspotutk=([^;]+)/) || [])[1] || null; }catch(e){ return null; }
};
window.sbCallFunction = function(name, body){   /* llama funciones públicas (calc-email, etc.) sin cargar el SDK de supabase-js */
  /* El token y la página REAL viajan con toda llamada, para que las functions que
     reenvían a HubSpot (calc-email, magnet-download) no tengan que acordarse.
     Antes mandaban pageUri fijo a la home: HubSpot creía que TODAS las
     conversiones pasaban ahí. */
  try{
    body = body || {};
    if(!body.hutk){ var k = window.vvHutk(); if(k) body.hutk = k; }
    if(!body.page_uri) body.page_uri = location.href;
    if(!body.page_name) body.page_name = document.title;
  }catch(e){}
  return fetch(SB_URL + '/functions/v1/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY },
    body: JSON.stringify(body), keepalive: true
  }).then(function(r){ return r.json(); }).catch(function(){ return null; });
};
(function(){
  /* no registrar visitas en desarrollo local */
  if(/^(localhost|127\.|192\.168\.)/.test(location.hostname)) return;

  /* session_id único por pestaña */
  var sid;
  try{
    sid = sessionStorage.getItem('viven-session');
    if(!sid){
      sid = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now() + '-' + Math.random().toString(36).slice(2);
      sessionStorage.setItem('viven-session', sid);
    }
  }catch(e){ sid = 'no-storage'; }
  window.__vvSid = sid;   /* lo usa el runtime de A/B para las exposiciones */

  /* ---- Atribución de origen: se calcula UNA vez al entrar (ahí está el
     referrer/UTM) y se hereda en el resto de la sesión ---- */
  function computeAttribution(){
    var q = new URLSearchParams(location.search);
    var utm = {
      source:   q.get('utm_source'),
      medium:   (q.get('utm_medium') || '').toLowerCase(),
      campaign: q.get('utm_campaign'),
      term:     q.get('utm_term'),
      content:  q.get('utm_content')
    };
    var gclid = q.get('gclid') || q.get('gbraid') || q.get('wbraid'); /* variantes iOS de Google Ads */
    var fbclid = q.get('fbclid');
    var refCode = q.get('ref'); /* código de referido — ?ref=REFxx en el link que comparte un cliente */
    var refHost = '';
    try{
      if(document.referrer) refHost = new URL(document.referrer).hostname.replace(/^www\./,'');
    }catch(e){}
    var own = refHost === location.hostname.replace(/^www\./,'');

    var AI     = /chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|anthropic\.com|gemini\.google\.com|copilot\.microsoft\.com|you\.com|poe\.com|mistral\.ai|deepseek\.com/i;
    var SEARCH = /(^|\.)google\.[a-z.]+$|(^|\.)bing\.com$|duckduckgo\.com|ecosia\.org|(^|\.)yahoo\.[a-z.]+$|yandex\.|startpage\.com|qwant\.com/i;
    var SOCIAL = /linkedin\.com|lnkd\.in|instagram\.com|facebook\.com|(^|\.)fb\.com|l\.facebook|t\.co$|(^|\.)x\.com$|twitter\.com|youtube\.com|youtu\.be|tiktok\.com|pinterest\./i;

    var channel;
    if(gclid || utm.source === 'google' && /cpc|ppc|paid|sem/.test(utm.medium)) channel = 'paid_search';
    else if(/cpc|ppc|paid|sem|display/.test(utm.medium)) channel = 'paid_search';
    else if(fbclid || /paid.?social/.test(utm.medium)) channel = 'paid_social';
    else if(utm.medium === 'email' || utm.source === 'newsletter') channel = 'email';
    else if(AI.test(refHost) || AI.test(utm.source || '')) channel = 'ai';
    else if(SEARCH.test(refHost)) channel = 'organic';
    else if(SOCIAL.test(refHost)) channel = 'social';
    else if(refHost && !own) channel = 'referral';
    else channel = 'direct';

    return {
      channel: channel,
      referrer: own ? null : (refHost || null),
      utm_source: utm.source, utm_medium: utm.medium || null,
      utm_campaign: utm.campaign, utm_term: utm.term, utm_content: utm.content,
      gclid: gclid, fbclid: fbclid, ref_code: refCode,
      landing_path: location.pathname
    };
  }

  var attrib = null, isEntry = false;
  try{
    var saved = sessionStorage.getItem('viven-attrib');
    if(saved){ attrib = JSON.parse(saved); }
    else{
      attrib = computeAttribution();
      isEntry = true;
      sessionStorage.setItem('viven-attrib', JSON.stringify(attrib));
    }
  }catch(e){ attrib = computeAttribution(); isEntry = true; }

  /* dispositivo por ancho de pantalla (mismos cortes que el CSS) */
  var w = window.innerWidth;
  var device = w <= 680 ? 'mobile' : (w <= 1024 ? 'tablet' : 'desktop');

  /* UUID propio de esta pageview → permite reportar el tiempo en página */
  var pvId = null;
  try{ if(window.crypto && crypto.randomUUID) pvId = crypto.randomUUID(); }catch(e){}

  sbInsert('pageviews', {
    pv_id: pvId,
    path: location.pathname,
    device: device,
    session_id: sid,
    referrer: attrib.referrer,
    channel: attrib.channel,
    utm_source: attrib.utm_source,
    utm_medium: attrib.utm_medium,
    utm_campaign: attrib.utm_campaign,
    utm_term: attrib.utm_term,
    utm_content: attrib.utm_content,
    gclid: attrib.gclid,
    fbclid: attrib.fbclid,
    lang: (navigator.language || null),
    is_entry: isEntry
  });

  /* ---- ¿Hay ALGUIEN del otro lado? ----------------------------------------
     Medido el 24/08/2026: de 6.943 "sesiones" en 30 días, 5.725 eran channel
     'direct' con UNA sola página y 78,5% de visitas de cero segundos. Ese piso
     de ~190 por día no varía y tapaba la señal real (~1.200), por eso los
     números del dashboard casi no se movían al cambiar el período. Es tráfico
     automático contado como visitantes.

     Un bot renderiza la página y se va: no scrollea, no mueve el mouse, no toca
     la pantalla. Una persona sí. Se registra ese hecho UNA vez por sesión.

     POR QUÉ ASÍ Y NO CON UNA COOKIE DE VISITANTE: un identificador persistente
     convertiría esto en dato personal, obligaría a pedir consentimiento, y como
     mucha gente lo rechaza el número pasaría a medir a los que aceptan cookies
     en vez de a los visitantes. Esto muere con la pestaña y no identifica a
     nadie — no hace falta consentimiento para contar que hubo alguien. */
  (function marcarActividadHumana(){
    var marcado = false;
    try{ if(sessionStorage.getItem('viven-activo') === '1') marcado = true; }catch(e){}
    if(marcado) return;

    var desde = Date.now();
    function marcar(kind){
      if(marcado) return;
      /* Los primeros 300ms se ignoran: al volver "atrás" el navegador restaura
         el scroll solo y eso dispararía un scroll que no hizo nadie. */
      if(Date.now() - desde < 300) return;
      marcado = true;
      try{ sessionStorage.setItem('viven-activo', '1'); }catch(e){}
      quitar();
      /* Si la sesión ya estaba registrada, la clave primaria lo rebota y no
         pasa nada: no hace falta comprobar antes. */
      sbInsert('session_activity', { session_id: sid, kind: kind });
    }
    function onScroll(){ marcar('scroll'); }
    function onPointer(e){ if(e && e.isTrusted !== false) marcar('pointer'); }
    function onTouch(){ marcar('touch'); }
    function onKey(){ marcar('key'); }
    function quitar(){
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('touchstart', onTouch);
      window.removeEventListener('keydown', onKey);
    }
    window.addEventListener('scroll', onScroll, { passive: true, once: false });
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('keydown', onKey);
  })();

  /* ---- Tiempo en página: se reporta al ocultar/cerrar la pestaña ---- */
  var t0 = Date.now();
  var lastSent = 0;
  function sendDuration(){
    if(!pvId) return;
    var secs = Math.round((Date.now() - t0) / 1000);
    if(secs < 3 || secs <= lastSent) return;  /* rebotes de <3s no aportan */
    lastSent = secs;
    fetch(SB_URL + '/rest/v1/rpc/update_duration', {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pv: pvId, secs: secs }),
      keepalive: true
    }).catch(function(){});
  }
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'hidden') sendDuration();
  });
  window.addEventListener('pagehide', sendDuration);

  /* la atribución queda disponible para el futuro insert de leads
     (formulario) — así cada lead nace con su gclid/canal/idioma.
     lang = idioma en que la persona está leyendo el sitio AHORA
     (selector EN/DE/ES), no el del navegador → es el idioma correcto
     para newsletters y email automations */
  window.vivenAttribution = function(){
    var siteLang = document.documentElement.lang;
    if(['en','de','es'].indexOf(siteLang) === -1){
      try{ siteLang = localStorage.getItem('viven-lang') || 'en'; }catch(e){ siteLang = 'en'; }
    }
    return { session_id: sid, lang: siteLang, attrib: attrib };
  };
})();

/* ---------- Funnels first-party (calc / brief / magnet) → tabla funnel_events ----------
   window.vvFunnel(funnel, step, label): 1 evento por sesión y step (dedupe en
   sessionStorage). Respeta viven-notrack (sbInsert ya lo gatea para todo lo que
   no sea leads) y no manda nada sin session id (__vvSid no existe en localhost). */
function vvFunnel(funnel, step, label){
  try{
    var fsid = window.__vvSid;
    if(!fsid) return;
    var k = 'vvf_' + funnel + '_' + step;
    try{ if(sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); }catch(e){ return; }
    sbInsert('funnel_events', { session_id: fsid, funnel: funnel, step: step, label: label || null, path: location.pathname });
  }catch(e){}
}
window.vvFunnel = vvFunnel;

(function vvFunnelInit(){
  /* --- funnel 'calc': las 3 calculadoras (EN/DE/ES) comparten markup, así que se
     instrumenta genérico desde acá y no se toca ninguna de las 3 páginas.
     step 0 = vio la página · steps 1..N = primer click en cada grupo de chips
     (orden de aparición del data-group en el DOM) · step N+1 = dejó su email. --- */
  var CALC_PATHS = ['/en/video-cost-calculator/', '/de/videoproduktion-kosten-rechner/', '/es/calculadora-costos-video/'];
  if(CALC_PATHS.indexOf(location.pathname.replace(/\/?$/, '/')) !== -1){
    var calcGroups = function(){
      var out = [];
      document.querySelectorAll('.calc-chips[data-group]').forEach(function(g){
        var name = g.getAttribute('data-group');
        if(out.indexOf(name) === -1) out.push(name);
      });
      return out;
    };
    vvFunnel('calc', 0, 'view');
    document.addEventListener('click', function(e){
      var btn = e.target && e.target.closest ? e.target.closest('.calc-chips button') : null;
      if(!btn) return;
      var g = btn.closest('.calc-chips');
      var name = g && g.getAttribute('data-group');
      if(!name) return;
      var idx = calcGroups().indexOf(name);
      if(idx !== -1) vvFunnel('calc', idx + 1, name);
    }, true);
    document.addEventListener('submit', function(e){
      var f = e.target;
      if(f && f.querySelector && f.querySelector('#cf-email')){
        vvFunnel('calc', calcGroups().length + 1, 'email_submitted');
        /* lead REAL (email + fila en leads) que nunca pasa por /thank-you/ —
           sin esto Google Ads/GA4 no ve ninguna conversión de la calculadora */
        track('generate_lead', {method: 'calculator', page: location.pathname});
      }
    }, true);
  }
  /* --- funnel 'magnet': step 0 al ver un gate de lead magnet en la página;
     el step 1 (email) se emite en el handler .lm-gate de más arriba. --- */
  if(document.querySelector('.lm-gate')) vvFunnel('magnet', 0, 'view');
})();

/* ---------- Señales UX (rage clicks / dead clicks / errores JS) → tabla ux_signals ----------
   Captura liviana: mismo opt-out que pageviews (via sbInsert) y máximo 20 señales
   por sesión — es un termómetro de fricción, no un session recorder. */
(function vvUxInit(){
  if(/^(localhost|127\.|192\.168\.)/.test(location.hostname)) return;
  var UX_MAX = 20;
  function uxSpent(){
    var n = 0;
    try{ n = parseInt(sessionStorage.getItem('vv_ux_n') || '0', 10) || 0; }catch(e){}
    return n;
  }
  function uxSelector(el){
    if(!el || !el.tagName) return null;
    var s = el.tagName.toLowerCase();
    if(el.id) s += '#' + el.id;
    else if(el.classList && el.classList.length) s += '.' + el.classList[0];
    return s.slice(0, 80);
  }
  function uxSend(kind, selector, detail){
    if(uxSpent() >= UX_MAX) return;
    try{ sessionStorage.setItem('vv_ux_n', String(uxSpent() + 1)); }catch(e){}
    var w = window.innerWidth;
    sbInsert('ux_signals', {
      session_id: window.__vvSid || null,
      kind: kind,
      selector: selector || null,
      detail: detail ? String(detail).slice(0, 200) : null,
      path: location.pathname,
      device: w <= 680 ? 'mobile' : (w <= 1024 ? 'tablet' : 'desktop')
    });
  }

  /* RAGE: 3+ clicks en un radio de 30px dentro de 1000ms */
  var rageClicks = [];
  document.addEventListener('click', function(e){
    var now = Date.now();
    rageClicks = rageClicks.filter(function(c){ return now - c.t <= 1000; });
    rageClicks.push({ t: now, x: e.clientX, y: e.clientY, el: e.target });
    if(rageClicks.length < 3) return;
    var last = rageClicks[rageClicks.length - 1];
    var near = rageClicks.filter(function(c){ return Math.abs(c.x - last.x) <= 30 && Math.abs(c.y - last.y) <= 30; });
    if(near.length >= 3){
      var el = last.el;
      var txt = el && el.textContent ? el.textContent.trim().slice(0, 40) : '';
      uxSend('rage', uxSelector(el), txt || null);
      rageClicks = [];   /* no reportar el mismo estallido dos veces */
    }
  }, true);

  /* DEAD: click en algo que PARECE interactivo pero 800ms después no produjo ni
     navegación ni mutación del DOM. Conservador a propósito: solo <a> sin href /
     href="#" y divs/spans con .btn o role=button — nunca <button> reales (pueden
     hacer trabajo sin tocar el DOM: copiar, fetch, etc.). Se excluye lo que vive
     dentro de forms, los chips de la calculadora y el switcher de idioma. */
  document.addEventListener('click', function(e){
    var t = e.target && e.target.closest ? e.target.closest('a, .btn, [role="button"]') : null;
    if(!t) return;
    var tag = t.tagName.toLowerCase();
    if(tag === 'button' || tag === 'input') return;
    if(tag === 'a'){
      var href = t.getAttribute('href');
      if(href && href !== '#') return;
    }
    if(t.closest('form') || t.closest('.calc-chips') || t.closest('.lang-link') || t.classList.contains('lang-link')) return;
    var mutated = false, mo;
    try{
      mo = new MutationObserver(function(){ mutated = true; });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    }catch(err){ return; }
    var url0 = location.href;
    setTimeout(function(){
      try{ mo.disconnect(); }catch(err){}
      if(mutated || location.href !== url0 || document.hidden) return;
      var txt = (t.textContent || '').trim().slice(0, 40);
      uxSend('dead', uxSelector(t), txt || null);
    }, 800);
  }, true);

  /* JSERROR: errores propios (archivo de viven.ch o relativo) — se ignoran los
     "Script error." cross-origin y todo lo que venga de extensiones del navegador */
  window.addEventListener('error', function(e){
    try{
      var msg = e && e.message ? String(e.message) : '';
      if(!msg || /^Script error\.?$/i.test(msg)) return;
      var fn = e.filename || '';
      if(!fn) return;
      if(!/^\//.test(fn) && fn.indexOf(location.hostname) === -1) return;
      uxSend('jserror', null, msg + ' @ ' + fn + ':' + (e.lineno || 0));
    }catch(err){}
  });
})();

/* ---------- profundidad de video: hitos 25/50/75/100 (dropoff) ----------
   El player de Vimeo emite eventos por postMessage; nos suscribimos al estar
   ready y reportamos cada hito UNA vez por video y sesión → el dashboard arma
   la curva de retención y cruza sesiones-que-vieron-video con leads. */
var vvVidMs = {};
var vvVidHooked = false;
window.addEventListener('message', function(e){
  if(String(e.origin).indexOf('player.vimeo.com') === -1) return;
  var d; try{ d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; }catch(err){ return; }
  if(!d || !d.event) return;
  var ifrEl = null;
  try{
    var ifrAll = document.querySelectorAll('iframe[src*="player.vimeo.com"]');
    for(var i0 = 0; i0 < ifrAll.length; i0++){ if(ifrAll[i0].contentWindow === e.source){ ifrEl = ifrAll[i0]; break; } }
  }catch(err){}
  if(d.event === 'ready'){
    try{
      ['playProgress', 'timeupdate', 'finish', 'ended'].forEach(function(ev){
        e.source.postMessage(JSON.stringify({ method: 'addEventListener', value: ev }), '*');
      });
    }catch(err){}
    /* FIX (hueco real): los embeds SUELTOS (case studies, testimonios, blog) nunca
       pasan por openVideo() — sus hitos 25/50/75/100 de abajo SÍ se guardaban, pero
       jamás quedaban contados como "reproducción" (pct=0) en el dashboard, aunque
       la gente los mirara y convirtiera. El modal central ya cuenta el arranque en
       openVideo(); acá cubrimos los que NO pasan por ahí (mount = el iframe del
       modal — si el iframe que mandó 'ready' no es ese, es un embed suelto). */
    if(ifrEl && (!mount || !mount.contains(ifrEl))){
      var m0 = ifrEl.src.match(/video\/(\d+)/), vid0 = m0 && m0[1];
      if(vid0){
        var seen0 = vvVidMs[vid0] = vvVidMs[vid0] || {};
        if(!seen0.start){
          seen0.start = true;
          if(!/^(localhost|127\.|192\.168\.)/.test(location.hostname)){
            sbInsert('video_plays', { session_id: sessionStorage.getItem('viven-session') || 'no-storage', video_id: String(vid0), label: ifrEl.title || null, lang: document.documentElement.lang || null });
          }
        }
      }
    }
    return;
  }
  var vid = ifrEl ? (ifrEl.src.match(/video\/(\d+)/) || [])[1] : null;
  var label = ifrEl ? (ifrEl.title || null) : null;
  if(!vid) return;
  var pct = null;
  if(d.event === 'finish' || d.event === 'ended') pct = 100;
  else if((d.event === 'playProgress' || d.event === 'timeupdate') && d.data && d.data.percent){
    var p = d.data.percent * 100;
    if(p >= 75) pct = 75; else if(p >= 50) pct = 50; else if(p >= 25) pct = 25;
  }
  if(pct === null) return;
  var seen = vvVidMs[vid] = vvVidMs[vid] || {};
  [25, 50, 75, 100].forEach(function(hm){
    if(hm <= pct && !seen[hm]){
      seen[hm] = true;
      if(!/^(localhost|127\.|192\.168\.)/.test(location.hostname)){
        sbInsert('video_plays', { session_id: sessionStorage.getItem('viven-session') || 'no-storage', video_id: String(vid), label: label, lang: document.documentElement.lang || null, pct: hm });
      }
    }
  });
});

})();
