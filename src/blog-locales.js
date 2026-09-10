// Resolve only translation relationships explicitly declared by existing posts.
// A translation can be published after its original; the original's generated
// langUrls may still point to the blog index. Build both directions together.
const sources = import.meta.glob('./pages/*/blog/*/index.astro', {
  query: '?raw', import: 'default', eager: true,
});
const posts = new Map(Object.entries(sources).map(([file, source]) => {
  const url = file.replace('./pages', '').replace('index.astro', '');
  const match = source.match(/langUrls=\{(\{[^\n]+?\})\}/);
  return [url, match ? JSON.parse(match[1]) : {}];
}));
const links = new Map([...posts.keys()].map((url) => [url, new Set()]));
for (const [url, translations] of posts) {
  for (const target of Object.values(translations)) {
    if (!posts.has(target)) continue;
    links.get(url).add(target);
    links.get(target).add(url);
  }
}

const resolved = new Map();
for (const url of posts.keys()) {
  if (resolved.has(url)) continue;
  const group = new Set();
  const pending = [url];
  while (pending.length) {
    const current = pending.pop();
    if (group.has(current)) continue;
    group.add(current);
    pending.push(...links.get(current));
  }
  const translations = {};
  for (const target of group) {
    const language = target.split('/')[1];
    if (translations[language] && translations[language] !== target) {
      throw new Error(`Conflicting blog translations for ${language}: ${[...group].join(', ')}`);
    }
    translations[language] = target;
  }
  for (const target of group) resolved.set(target, translations);
}

export function blogLanguageUrls(url) {
  return resolved.get(url) || null;
}
