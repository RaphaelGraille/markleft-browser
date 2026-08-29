// Runs marked.parse() + hljs.highlight() off the main thread, so parsing a
// big markdown file never blocks keyboard/mouse input on the page. Pure
// string in, string out -- no DOM access here (workers don't have one);
// the main thread does the (cheap) innerHTML assignment and link rewriting.
importScripts("/static/vendor/marked.min.js", "/static/vendor/highlight.min.js");

const renderer = new marked.Renderer();
renderer.code = (code, infostring) => {
  const lang = (infostring || "").trim().split(/\s+/)[0];
  let html;
  if (lang && hljs.getLanguage(lang)) {
    html = hljs.highlight(code, { language: lang }).value;
  } else {
    html = hljs.highlightAuto(code).value;
  }
  return `<pre><code class="hljs">${html}</code></pre>`;
};
marked.setOptions({ renderer, gfm: true });

self.onmessage = (e) => {
  const { requestId, rawText } = e.data;
  const html = marked.parse(rawText);
  self.postMessage({ requestId, html });
};
