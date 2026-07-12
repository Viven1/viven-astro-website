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
  document.querySelectorAll('[data-' + lang + ']').forEach(function(el){
    el.innerHTML = el.getAttribute('data-' + lang);
  });
  document.querySelectorAll('[data-' + lang + '-ph]').forEach(function(el){
    el.setAttribute('placeholder', el.getAttribute('data-' + lang + '-ph'));
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
/* ¿vale la pena autoplay del video pesado? En desktop siempre; en mobile SOLO
   con buena conexión y sin ahorro de datos (si no, se queda el póster ligero). */
function heroVideoAllowed(){
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  var desktop = window.matchMedia('(min-width: 768px)').matches;
  var c = navigator.connection || {};
  if(c.saveData) return false;                                   /* Data Saver activo */
  if(c.effectiveType && !/(^|\s)4g/.test(c.effectiveType)) return false; /* 2g/3g → no */
  if(navigator.deviceMemory && navigator.deviceMemory < 4) return false; /* poca RAM → no */
  /* Llegamos acá solo si NO hay señal de conexión mala (ni saveData, ni 2g/3g, ni poca RAM).
     Permitimos el video en desktop y mobile. iOS Safari no tiene Network API → igual carga. */
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
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.src = heroMp4;
    /* fade-in: el video aparece suave sobre el póster — sin salto de color al navegar */
    v.addEventListener('playing', function(){ v.classList.add('on'); }, { once: true });
    heroBg.insertBefore(v, heroBg.querySelector('.grain'));
    var pr = v.play(); if(pr && pr.catch) pr.catch(function(){});
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
  if(!heroBg || !heroId) return;
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
    if(window.__vvAB) row.ab = window.__vvAB;   /* variantes A/B que vio (conversión por variante) */
    if(extra){
      row.session_id = extra.session_id;
      row.lang = extra.lang;
      if(extra.attrib){
        row.channel = extra.attrib.channel;
        row.gclid = extra.attrib.gclid;
        row.utm_source = extra.attrib.utm_source;
        row.utm_campaign = extra.attrib.utm_campaign;
        row.landing_path = extra.attrib.landing_path;
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

/* ---------- Lead conversion tracking (GA4, consent-gated: no-ops until gtag exists) ---------- */
function track(name, params){ if(typeof window.gtag === 'function') window.gtag('event', name, params || {}); }
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
var consent = null;
try{ consent = localStorage.getItem('viven-cookie'); }catch(e){}
if(consent === 'accepted') loadGA();
if(consent === null){
  var bar = document.createElement('div');
  bar.id = 'cookie-bar';
  bar.innerHTML =
    '<p>Wir verwenden Cookies für Analysezwecke. / We use cookies for analytics. / Usamos cookies con fines analíticos. ' +
    '<a href="/privacy-policy/">Privacy</a></p>' +
    '<div class="cookie-btns">' +
    '<button id="cookie-decline">Decline</button>' +
    '<button id="cookie-accept">Accept</button>' +
    '</div>';
  document.body.appendChild(bar);
  document.getElementById('cookie-accept').onclick = function(){
    try{ localStorage.setItem('viven-cookie','accepted'); }catch(e){}
    bar.remove();
    loadGA();
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
      };
      if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
      /* anti-carrera: si el swap de idioma pisa la variante, la re-aplicamos */
      setTimeout(run2, 700);
      function run2(){ tests.forEach(function(t){ var b2 = force && force.id === t.id ? force.b : (function(){ try{ return localStorage.getItem('vv_ab_' + t.id); }catch(e){ return null; } })(); if(b2 === 'b') vvAbApply(t.changes); }); }
    }).catch(function(){});
  }catch(e){}
})();


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
    else if(AI.test(refHost)) channel = 'ai';
    else if(SEARCH.test(refHost)) channel = 'organic';
    else if(SOCIAL.test(refHost)) channel = 'social';
    else if(refHost && !own) channel = 'referral';
    else channel = 'direct';

    return {
      channel: channel,
      referrer: own ? null : (refHost || null),
      utm_source: utm.source, utm_medium: utm.medium || null,
      utm_campaign: utm.campaign, utm_term: utm.term, utm_content: utm.content,
      gclid: gclid, fbclid: fbclid,
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
  if(d.event === 'ready'){
    try{
      ['playProgress', 'timeupdate', 'finish', 'ended'].forEach(function(ev){
        e.source.postMessage(JSON.stringify({ method: 'addEventListener', value: ev }), '*');
      });
    }catch(err){}
    return;
  }
  var vid = null, label = null;
  try{
    var ifr = document.querySelectorAll('iframe[src*="player.vimeo.com"]');
    for(var i = 0; i < ifr.length; i++){
      if(ifr[i].contentWindow === e.source){ var m = ifr[i].src.match(/video\/(\d+)/); vid = m && m[1]; label = ifr[i].title || null; break; }
    }
  }catch(err){}
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
