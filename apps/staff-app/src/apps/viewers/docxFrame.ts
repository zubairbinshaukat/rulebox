import DOMPurify from "dompurify";

/**
 * A Word document is shown inside a sandboxed frame. `sandbox=""` is the
 * strictest setting: no scripts, no same-origin access, no forms, no popups,
 * no navigation. The frame also carries its own policy, so even a style rule
 * that asks for a remote picture or font gets nothing.
 */
export const DOCX_FRAME_SANDBOX = "";

export const DOCX_FRAME_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

/** Markup from the converter, made safe: scripts, event handlers and active content are removed. */
export function sanitizeDocx(html: string): string {
  return DOMPurify.sanitize(html, {
    // The converter writes the document's styles as <style> elements.
    ADD_TAGS: ["style"],
    FORCE_BODY: true,
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "link", "meta", "base"],
    FORBID_ATTR: ["srcset"],
  });
}

/** The document inside the frame (`srcdoc`). The policy comes first. */
export function docxSrcdoc(safeHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${DOCX_FRAME_CSP}">` +
    `<style>html{background:#e8e6e1}body{margin:0;padding:16px}.docx-wrapper{background:transparent!important;padding:0!important}.docx-wrapper>section.docx{margin:0 auto 16px!important;box-shadow:0 1px 4px rgba(0,0,0,.25)}</style>` +
    `</head><body>${safeHtml}</body></html>`
  );
}
