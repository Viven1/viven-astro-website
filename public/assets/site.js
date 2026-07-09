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
  mount.innerHTML = '<iframe src="https://player.vimeo.com/video/' + id + '?autoplay=1&dnt=1&title=0&byline=0&portrait=0" allow="autoplay; fullscreen; picture-in-picture" title="' + (title || 'Viven video') + '"></iframe>';
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
  if(!id || !thumb || thumb.style.backgroundImage) return;
  var cb = 'vmb_' + id + '_' + Math.floor(Math.random() * 1e6);
  window[cb] = function(data){
    if(data && data.thumbnail_url){
      thumb.style.backgroundImage = "url('" + data.thumbnail_url + "')";
    }
    try{ delete window[cb]; }catch(e){}
  };
  var s = document.createElement('script');
  s.src = 'https://vimeo.com/api/oembed.json?url=https://vimeo.com/' + id + '&width=800&callback=' + cb;
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

/* ---------- HubSpot form (lazy: loads when section nears viewport) ---------- */
var hsMount = document.querySelector('.hs-form-mount');
if(hsMount){
  var hsLoaded = false;
  var loadHS = function(){
    if(hsLoaded) return; hsLoaded = true;
    var s = document.createElement('script');
    s.src = 'https://js.hsforms.net/forms/embed/v2.js';
    s.charset = 'utf-8';
    s.onload = function(){
      if(window.hbspt){
        window.hbspt.forms.create({
          portalId: hsMount.dataset.portal || '4084680',
          formId: hsMount.dataset.form || '994b80e1-84c2-42de-a5a1-ea2145608d76',
          region: hsMount.dataset.region || 'na1',
          target: '.hs-form-mount'
        });
      }
    };
    document.head.appendChild(s);
  };
  var hsIO = new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){ loadHS(); hsIO.disconnect(); } });
  },{rootMargin:'500px'});
  hsIO.observe(hsMount);
}

/* ---------- Lead conversion tracking (GA4, consent-gated: no-ops until gtag exists) ---------- */
function track(name, params){ if(typeof window.gtag === 'function') window.gtag('event', name, params || {}); }
/* HubSpot form submit → generate_lead */
window.addEventListener('message', function(e){
  if(e.data && e.data.type === 'hsFormCallback' && e.data.eventName === 'onFormSubmitted'){
    track('generate_lead', {method: 'hubspot_form', form_id: e.data.id || ''});
  }
});
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

})();
