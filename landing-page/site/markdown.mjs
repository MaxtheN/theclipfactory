// A small Markdown renderer for the user guide (docs/guide/*.md). It covers exactly what the guide uses:
// headings, paragraphs, bullet and numbered lists, tables, fenced code, block quotes, bold, italic, inline
// code and links. Unknown syntax renders as plain escaped text, never as raw HTML.

export const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub-style heading anchor; tests/test_help_api.py uses the same rule. */
export function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/\s/g, "-");
}

function plain(markdown) {
  return markdown.replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*?([^*]+)\*\*?/g, "$1");
}

export function inline(text, rewriteLink = (href) => href) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const target = rewriteLink(href.replace(/&amp;/g, "&"));
    const external = /^https?:/.test(target) && !target.startsWith("https://growth-factory-landing.vercel.app");
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${escapeHtml(target)}"${attrs}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

/**
 * Render Markdown to HTML. Returns {html, title, headings}: the first H1 becomes `title` (and is not rendered),
 * `headings` lists the H2s for an on-this-page index.
 */
export function renderMarkdown(source, { rewriteLink } = {}) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  const headings = [];
  const seen = new Map();
  const md = (text) => inline(text, rewriteLink);
  let title = "";
  let i = 0;

  const isBlockStart = (line) =>
    /^(#{1,6})\s/.test(line) || /^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line) ||
    line.startsWith("|") || line.startsWith("```") || line.startsWith(">");

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      if (level === 1 && !title) { title = plain(text); i++; continue; }
      let id = slug(text);
      const count = seen.get(id) || 0;
      seen.set(id, count + 1);
      if (count) id = `${id}-${count}`;
      if (level === 2) headings.push({ id, text: plain(text) });
      html.push(`<h${level} id="${id}">${md(text)}</h${level}>`);
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (line.startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "")) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].startsWith("|"); i++) rows.push(cells(lines[i]));
      const th = head.map((cell) => `<th scope="col">${md(cell)}</th>`).join("");
      const body = rows.map((row) => `<tr>${row.map((cell, c) => (c === 0 ? `<th scope="row">${md(cell)}</th>` : `<td>${md(cell)}</td>`)).join("")}</tr>`).join("");
      html.push(`<div class="table-scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    if (line.startsWith(">")) {
      const body = [];
      for (; i < lines.length && lines[i].startsWith(">"); i++) body.push(lines[i].replace(/^>\s?/, ""));
      html.push(`<blockquote>${renderMarkdown(body.join("\n"), { rewriteLink }).html}</blockquote>`);
      continue;
    }

    const listItem = /^\s*([-*]|\d+\.)\s+(.*)$/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length) {
        const match = lines[i].match(listItem);
        if (match) { items.push([match[2]]); i++; continue; }
        if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items.at(-1).push(lines[i].trim()); i++; continue; }
        if (!lines[i].trim() && listItem.test(lines[i + 1] || "")) { i++; continue; }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((parts) => `<li>${md(parts.join(" "))}</li>`).join("")}</${tag}>`);
      continue;
    }

    const para = [line.trim()];
    for (i++; i < lines.length && lines[i].trim() && !isBlockStart(lines[i]); i++) para.push(lines[i].trim());
    html.push(`<p>${md(para.join(" "))}</p>`);
  }
  return { html: html.join("\n"), title, headings };
}
