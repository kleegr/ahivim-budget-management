/** Read the actual text operators in a downloaded synthetic PDF. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  try {
    const pages: string[] = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      pages.push(content.items.map(item => 'str' in item ? item.str : '').join(' '));
    }
    return pages.join('\n');
  } finally { await pdf.destroy(); }
}
