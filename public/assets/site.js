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

/* ---------- Reveal on scroll ---------- */
var revealIO = new IntersectionObserver(function(entries){
  entries.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); revealIO.unobserve(e.target); } });
},{threshold:.12, rootMargin:'0px 0px -40px 0px'});
document.querySelectorAll('.reveal').forEach(function(el){ revealIO.observe(el); });

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
document.querySelectorAll('.lang button').forEach(function(b){
  b.addEventListener('click', function(){ setLang(b.dataset.lang); });
});
var urlLang = new URLSearchParams(window.location.search).get('lang');
var saved = null;
try{ saved = localStorage.getItem('viven-lang'); }catch(e){}
var nav = (navigator.language || '').toLowerCase();
var browserLang = nav.indexOf('de') === 0 ? 'de' : (nav.indexOf('es') === 0 ? 'es' : 'en');
setLang(LANGS.indexOf(urlLang) !== -1 ? urlLang : (saved || browserLang));

/* ---------- Vimeo: hero background (desktop-only, deferred for LCP) ---------- */
var heroBg = document.querySelector('.hero-bg');
var heroId = heroBg && (heroBg.dataset.vimeo || '').trim();
function loadHeroVideo(){
  if(!heroId || heroBg.querySelector('.hero-video')) return;
  if(!window.matchMedia('(min-width: 768px)').matches) return;
  var f = document.createElement('iframe');
  f.className = 'hero-video';
  f.src = 'https://player.vimeo.com/video/' + heroId + '?background=1&autoplay=1&loop=1&muted=1&dnt=1';
  f.allow = 'autoplay; fullscreen';
  f.title = 'Viven showreel';
  f.loading = 'lazy';
  heroBg.insertBefore(f, heroBg.querySelector('.grain'));
}
var idle = window.requestIdleCallback || function(cb){ return setTimeout(cb, 250); };
if(document.readyState === 'complete') idle(loadHeroVideo);
else window.addEventListener('load', function(){ idle(loadHeroVideo); });

/* ---------- Video modal (shared) ---------- */
var modal = document.getElementById('video-modal');
var mount = document.getElementById('video-mount');
function openVideo(id, title){
  if(!id || !modal) return false;
  mount.innerHTML = '<iframe src="https://player.vimeo.com/video/' + id + '?autoplay=1&dnt=1&title=0&byline=0&portrait=0" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" title="' + (title || 'Viven video') + '"></iframe>';
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

/* Work tiles + case study tops → modal */
document.querySelectorAll('.work-tile').forEach(function(tile){
  var id = (tile.dataset.vimeo || '').trim();
  if(!id){ tile.style.display = 'none'; return; }
  tile.addEventListener('click', function(){ openVideo(id, tile.dataset.label || 'Viven'); });
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
        var show = f === 'all' || (tile.dataset.cat || '').split(' ').indexOf(f) !== -1;
        tile.style.display = show ? '' : 'none';
        if(show) loadVimeoThumb(tile);
      });
    });
  });
}

/* ---------- Lead form propio (guarda en Supabase → tabla leads) ---------- */
function renderLeadForm(mount){
  mount.innerHTML =
    '<form class="lead-form" novalidate>' +
      '<div class="field">' +
        '<label data-en=\'Name <span class="req">*</span>\' data-de=\'Name <span class="req">*</span>\' data-es=\'Nombre <span class="req">*</span>\'>Name <span class="req">*</span></label>' +
        '<input type="text" name="name" required maxlength="120" autocomplete="name" />' +
      '</div>' +
      '<div class="field">' +
        '<label data-en=\'Work email <span class="req">*</span>\' data-de=\'Gesch&auml;ftliche E-Mail <span class="req">*</span>\' data-es=\'Email de trabajo <span class="req">*</span>\'>Work email <span class="req">*</span></label>' +
        '<input type="email" name="email" required maxlength="200" autocomplete="email" />' +
      '</div>' +
      '<div class="field">' +
        '<label data-en="What are you working on?" data-de="Woran arbeiten Sie?" data-es="&iquest;En qu&eacute; est&aacute;s trabajando?">What are you working on?</label>' +
        '<textarea name="message" maxlength="4000" rows="4"></textarea>' +
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
  /* ojo: form.name devuelve el atributo del <form>, NO el input llamado "name" */
  var fName = form.querySelector('[name="name"]');
  var fEmail = form.querySelector('[name="email"]');
  var fMsg = form.querySelector('[name="message"]');
  var fHp = form.querySelector('[name="website"]');

  form.addEventListener('submit', function(e){
    e.preventDefault();
    form.classList.remove('has-error');
    var name = fName.value.trim();
    var email = fEmail.value.trim();
    if(!name || !email || !fEmail.checkValidity()){ form.reportValidity(); return; }
    /* anti-spam: honeypot lleno o envío en <3s = bot → éxito falso, sin guardar */
    if(fHp.value || (Date.now() - renderedAt) < 3000){
      form.style.display = 'none'; okBox.classList.add('show');
      return;
    }
    var btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    var extra = window.vivenAttribution ? window.vivenAttribution() : null;
    var row = {
      name: name,
      email: email,
      message: fMsg.value.trim() || null
    };
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
    sbInsert('leads', row).then(function(r){
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
document.querySelectorAll('.lead-form-mount').forEach(function(m){ renderLeadForm(m); });
/* el idioma ya se aplicó al cargar — re-aplicar sobre el formulario recién montado */
if(document.querySelector('.lead-form')) setLang(document.documentElement.lang || 'en');

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
function sbInsert(table, row){
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
