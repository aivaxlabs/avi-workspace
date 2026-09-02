import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.use({ gfm: true, breaks: true });

export function renderMarkdown(value) {
  return DOMPurify.sanitize(marked.parse(String(value ?? '')), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  });
}
