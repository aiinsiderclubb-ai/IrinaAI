import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractText, fileKind, findUrls, UnsupportedFile } from '../src/files/extract.js';

// ---- fixtures, built in code ---------------------------------------------------------------------------------

const PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

function rels(list: [id: string, type: string, target: string, external?: boolean][]): string {
  const items = list.map(
    ([id, type, target, ext]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${ext ? ' TargetMode="External"' : ''}/>`,
  );
  return `${XML}<Relationships xmlns="${PKG_RELS}">${items.join('')}</Relationships>`;
}

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R}"`;

function makeDocx(): Uint8Array {
  const cell = (t: string) => `<w:tc><w:tcPr/><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/_rels/document.xml.rels': rels([
      ['rId1', 'styles', 'styles.xml'],
      ['rId5', 'hyperlink', 'https://example.com/docx-link?a=1&amp;b=2', true],
    ]),
    // a localized document: style id "a3" is named "heading 2"
    'word/styles.xml': `${XML}<w:styles ${W}><w:style w:type="paragraph" w:styleId="a3"><w:name w:val="heading 2"/><w:basedOn w:val="a"/></w:style></w:styles>`,
    'word/document.xml': `${XML}<w:document ${W}><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Звіт за квартал</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Дивіться </w:t></w:r><w:hyperlink r:id="rId5" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>сайт компанії</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> для деталей &amp; цифр.</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Перший пункт</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="a3"/></w:pPr><w:r><w:t>Витрати</w:t></w:r></w:p>
      <w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>
        <w:tr>${cell('Назва')}${cell('Сума')}</w:tr>
        <w:tr>${cell('Кава')}${cell('120')}</w:tr>
      </w:tbl>
      <w:p><w:r><w:t>Колонка</w:t><w:tab/><w:t>два</w:t><w:br/><w:t>Новий рядок</w:t></w:r></w:p>
      <w:p><w:del w:id="1" w:author="x"><w:r><w:delText>видалений текст</w:delText></w:r></w:del></w:p>
      <w:sectPr/></w:body></w:document>`,
  });
}

const P = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
const shape = (ph: string | undefined, paras: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
const para = (...runs: string[]) => `<a:p>${runs.join('')}<a:endParaRPr lang="uk-UA"/></a:p>`;
const run = (t: string, link?: string) =>
  `<a:r><a:rPr lang="uk-UA">${link ? `<a:hlinkClick r:id="${link}"/>` : ''}</a:rPr><a:t>${t}</a:t></a:r>`;
const slide = (...shapes: string[]) =>
  `${XML}<p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;

function makePptx(): Uint8Array {
  return zip({
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': `${XML}<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide2.xml'],
    ]),
    'ppt/slides/slide1.xml': slide(
      shape('title', para(run('Перший слайд'))),
      shape(undefined, para(run('Деталі на '), run('нашому сайті', 'rId2'))),
      shape('sldNum', para(run('1'))),
    ),
    'ppt/slides/_rels/slide1.xml.rels': rels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'hyperlink', 'https://example.com/pptx-link', true],
      ['rId3', 'notesSlide', '../notesSlides/notesSlide1.xml'],
    ]),
    'ppt/notesSlides/notesSlide1.xml': `${XML}<p:notes ${P}><p:cSld><p:spTree>${shape('sldImg', '')}${shape('body', para(run('Сказати про бюджет')))}${shape('sldNum', para(run('1')))}</p:spTree></p:cSld></p:notes>`,
    'ppt/slides/slide2.xml': slide(shape('title', para(run('Другий слайд'))), shape('body', para(run('Підсумки')) + para(run('Дякую')))),
    'ppt/slides/_rels/slide2.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
  });
}

const S = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"`;

function makeXlsx(extraRows = 0): Uint8Array {
  let filler = '';
  for (let i = 0; i < extraRows; i++) filler += `<row r="${10 + i}"><c r="A${10 + i}"><v>${i}</v></c></row>`;
  return zip({
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `${XML}<workbook ${S}><workbookPr/><sheets><sheet name="Бюджет" sheetId="1" r:id="rId1"/><sheet name="Контакти" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels([
      ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
      ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
      ['rId3', 'sharedStrings', 'sharedStrings.xml'],
      ['rId4', 'styles', 'styles.xml'],
    ]),
    'xl/sharedStrings.xml': `${XML}<sst ${S} count="4" uniqueCount="4"><si><t>Стаття</t></si><si><r><t>Ка</t></r><r><rPr><b/></rPr><t>ва</t></r></si><si><t>Сума</t></si><si><t>Дата</t></si></sst>`,
    // cell style 1 = a custom date format
    'xl/styles.xml': `${XML}<styleSheet ${S}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `${XML}<worksheet ${S}><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="C1" t="s"><v>3</v></c></row>
      <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>120.5</v></c><c r="C2" s="1"><v>45658</v></c></row>
      <row r="3"/>
      <row r="4"><c r="A4" t="inlineStr"><is><t>Разом</t></is></c><c r="C4"><f>SUM(B2:B3)</f><v>300</v></c></row>
      ${filler}
    </sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `${XML}<worksheet ${S}><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Сайт</t></is></c></row>
      <row r="2"><c r="A2" t="str"><f>"x"</f><v>Наш сайт</v></c><c r="B2" t="b"><v>1</v></c></row>
    </sheetData><hyperlinks><hyperlink ref="A2" r:id="rId1"/></hyperlinks></worksheet>`,
    'xl/worksheets/_rels/sheet2.xml.rels': rels([['rId1', 'hyperlink', 'https://example.com/xlsx-link', true]]),
  });
}

/** a tiny valid PDF: one Helvetica text line per page (empty string = page with no text), optional link annotation */
function makePdf(pages: string[], uri?: string): Uint8Array {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '', // pages, filled below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  const kids: number[] = [];
  for (const text of pages) {
    const pageId = objects.length + 1;
    const contentId = pageId + 1;
    const annotId = uri ? pageId + 2 : 0;
    kids.push(pageId);
    const stream = text ? `BT /F1 24 Tf 72 700 Td (${text}) Tj ET` : '';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >>${annotId ? ` /Annots [${annotId} 0 R]` : ''} >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
    if (annotId) objects.push(`<< /Type /Annot /Subtype /Link /Rect [72 690 400 730] /Border [0 0 0] /A << /S /URI /URI (${uri}) >> >>`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf); // ASCII only, so string offsets are byte offsets
}

/** encode to windows-1251 with a table built from the platform's own decoder */
function cp1251(text: string): Uint8Array {
  const dec = new TextDecoder('windows-1251');
  const table = new Map<string, number>();
  for (let b = 0; b < 256; b++) table.set(dec.decode(new Uint8Array([b])), b);
  return new Uint8Array([...text].map((ch) => table.get(ch) ?? 0x3f));
}

const u8 = (s: string) => new TextEncoder().encode(s);

// ---- tests ------------------------------------------------------------------------------------------------------

describe('extractText: Office files', () => {
  it('docx keeps headings, lists, tables and hyperlinks', async () => {
    const r = await extractText(makeDocx(), 'Звіт.docx');
    expect(r.kind).toBe('docx');
    expect(r.text).toContain('## Звіт за квартал');
    expect(r.text).toContain('Дивіться сайт компанії (https://example.com/docx-link?a=1&b=2) для деталей & цифр.');
    expect(r.text).toContain('- Перший пункт');
    expect(r.text).toContain('## Витрати'); // heading found through styles.xml
    expect(r.text).toContain('| Назва | Сума |\n| Кава | 120 |');
    expect(r.text).toContain('Колонка\tдва\nНовий рядок');
    expect(r.text).not.toContain('видалений');
    expect(r.links).toEqual(['https://example.com/docx-link?a=1&b=2']);
    expect(r.truncated).toBeUndefined();
  });

  it('recognises an Office file by its content when the name and type say nothing', async () => {
    const r = await extractText(makeDocx(), 'file', 'application/octet-stream');
    expect(r.kind).toBe('docx');
    expect(r.text).toContain('## Звіт за квартал');
  });

  it('pptx: slides in presentation order, notes, hyperlinks; slide numbers dropped', async () => {
    const r = await extractText(makePptx(), 'deck.pptx');
    expect(r.kind).toBe('pptx');
    expect(r.units).toBe(2);
    expect(r.text).toContain(
      '### Слайд 1\nПерший слайд\nДеталі на нашому сайті (https://example.com/pptx-link)\nНотатки: Сказати про бюджет',
    );
    expect(r.text).toContain('### Слайд 2\nДругий слайд\nПідсумки\nДякую');
    expect(r.text.split('\n')).not.toContain('1');
    expect(r.links).toEqual(['https://example.com/pptx-link']);
  });

  it('xlsx: sheets, shared + inline strings, numbers, dates, column positions, hyperlinks', async () => {
    const r = await extractText(makeXlsx(), 'budget.xlsx');
    expect(r.kind).toBe('xlsx');
    expect(r.units).toBe(2);
    expect(r.text).toContain(
      '### Аркуш «Бюджет»\n| Стаття | Сума | Дата |\n| Кава | 120.5 | 2025-01-01 |\n| Разом |  | 300 |',
    );
    expect(r.text).toContain('### Аркуш «Контакти»\n| Сайт |  |\n| Наш сайт (https://example.com/xlsx-link) | TRUE |');
    expect(r.text).not.toContain('SUM(');
    expect(r.links).toEqual(['https://example.com/xlsx-link']);
  });

  it('xlsx: long sheets are capped at 2000 rows with a note', async () => {
    const r = await extractText(makeXlsx(2005), 'big.xlsx');
    expect(r.text).toContain('…ще 8 рядків'); // 3 data rows + 2005 filler = 2008
    expect(r.text).toContain('| 1996 |');
    expect(r.text).not.toContain('| 1997 |');
  });
});

describe('extractText: PDF', () => {
  it('reads the text layer, page count and link annotations', async () => {
    const r = await extractText(makePdf(['Hello PDF world', 'Second page here'], 'https://example.com/pdf-link'), 'doc.pdf');
    expect(r.kind).toBe('pdf');
    expect(r.units).toBe(2);
    expect(r.text).toContain('Hello PDF world');
    expect(r.text).toContain('Second page here');
    expect(r.text.indexOf('Hello')).toBeLessThan(r.text.indexOf('Second'));
    expect(r.links).toEqual(['https://example.com/pdf-link']);
  });

  it('a PDF without a text layer (a scan) gives empty text, not an error', async () => {
    const r = await extractText(makePdf(['']), 'scan.pdf', 'application/pdf');
    expect(r).toMatchObject({ kind: 'pdf', text: '', units: 1 });
  });

  it('a broken PDF is an UnsupportedFile', async () => {
    await expect(extractText(u8('%PDF-1.4\nnonsense'), 'x.pdf')).rejects.toBeInstanceOf(UnsupportedFile);
  });
});

describe('extractText: text formats', () => {
  it('csv: quoted fields with commas, quotes and newlines become table rows', async () => {
    const csv = 'name,comment\r\n"Іван","Привіт, світ"\r\n"Олена","рядок1\nрядок2 ""цитата"""\r\n\r\n';
    const r = await extractText(u8(csv), 'people.csv');
    expect(r.kind).toBe('csv');
    expect(r.text).toBe('| name | comment |\n| Іван | Привіт, світ |\n| Олена | рядок1 рядок2 "цитата" |');
  });

  it('csv with semicolons and tsv by tabs', async () => {
    expect((await extractText(u8('a;b;c\n1;2,5;3'), 'eu.csv')).text).toBe('| a | b | c |\n| 1 | 2,5 | 3 |');
    expect((await extractText(u8('a\tb, c\n1\t2'), 'data.tsv')).text).toBe('| a | b, c |\n| 1 | 2 |');
  });

  it('falls back to windows-1251 when the text is not UTF-8', async () => {
    const r = await extractText(cp1251('Привіт, світ! Їжак і ґанок.'), 'old.txt');
    expect(r.kind).toBe('text');
    expect(r.text).toBe('Привіт, світ! Їжак і ґанок.');
  });

  it('html: no scripts or styles, headings, lists, links, entities', async () => {
    const html =
      '<html><head><title>Сторінка</title><style>.x{color:red}</style></head><body><h1>Заголовок</h1>' +
      '<p>Текст &amp; ще <a href="https://example.com/h">посилання</a></p><script>alert(1)</script>' +
      '<ul><li>один</li><li>два</li></ul></body></html>';
    const r = await extractText(u8(html), 'page.html');
    expect(r.kind).toBe('html');
    expect(r.text).toContain('## Заголовок');
    expect(r.text).toContain('Текст & ще посилання (https://example.com/h)');
    expect(r.text).toContain('- один\n- два');
    expect(r.text).not.toMatch(/alert|color/);
    expect(r.links).toEqual(['https://example.com/h']);
  });

  it('json is pretty-printed; text keeps its URLs as links', async () => {
    expect((await extractText(u8('{"a":1,"b":[1,2]}'), 'x.json')).text).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    const r = await extractText(u8('Notes\n\n\n\n\nSee https://example.com/x.   \n'), 'notes.md');
    expect(r).toMatchObject({ kind: 'text', text: 'Notes\n\nSee https://example.com/x.', links: ['https://example.com/x'] });
  });

  it('cuts at maxChars and says so', async () => {
    const r = await extractText(u8(`${'а'.repeat(1000)} https://example.com/tail`), 'long.txt', undefined, { maxChars: 100 });
    expect(r.text).toHaveLength(100);
    expect(r.truncated).toBe(true);
    expect(r.links).toEqual(['https://example.com/tail']); // links come from the whole file
  });
});

describe('unsupported files', () => {
  it('old .doc / .xls are refused with a hint in Ukrainian', async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const err = await extractText(ole, 'old.doc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedFile);
    expect((err as Error).message).toBe('Формат .doc не підтримується — збережіть як .docx або PDF');
    await expect(extractText(u8('anything'), 'table.xls')).rejects.toThrow(/\.xls не підтримується.*\.xlsx/);
    // a password-protected .docx is an OLE container too
    await expect(extractText(ole, 'secret.docx')).rejects.toThrow(/паролем/);
  });

  it('images and archives are not documents', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    await expect(extractText(png, 'photo.jpg')).rejects.toBeInstanceOf(UnsupportedFile);
    await expect(extractText(png, 'scan.pdf')).rejects.toBeInstanceOf(UnsupportedFile);
    await expect(extractText(zip({ 'a.txt': 'hi' }), 'files.zip')).rejects.toThrow(/Архіви/);
    await expect(extractText(new Uint8Array([0, 1, 2, 3, 0, 0, 7]), 'blob.bin')).rejects.toBeInstanceOf(UnsupportedFile);
  });
});

describe('fileKind', () => {
  it('maps names and MIME types', () => {
    expect(fileKind('a.DOCX')).toBe('docx');
    expect(fileKind('a.pdf')).toBe('pdf');
    expect(fileKind('report', 'application/pdf')).toBe('pdf');
    expect(fileKind('a.xlsx')).toBe('xlsx');
    expect(fileKind('a.pptx')).toBe('pptx');
    expect(fileKind('a.csv', 'application/vnd.ms-excel')).toBe('csv');
    expect(fileKind('a.tsv')).toBe('csv');
    expect(fileKind('a.md')).toBe('text');
    expect(fileKind('a.htm')).toBe('html');
    expect(fileKind('a.json')).toBe('json');
    expect(fileKind('photo.HEIC')).toBe('image');
    expect(fileKind('x', 'image/png')).toBe('image');
    expect(fileKind('a.doc')).toBeUndefined();
    expect(fileKind('a.xls', 'application/vnd.ms-excel')).toBeUndefined();
    expect(fileKind('a.zip')).toBeUndefined();
    expect(fileKind('x', 'application/octet-stream')).toBeUndefined();
  });
});

describe('findUrls', () => {
  it('strips trailing punctuation, keeps balanced parentheses, dedupes', () => {
    const text =
      'Дивись (https://example.com/a). Також https://example.com/b, і «https://example.com/c» та ' +
      '"https://example.com/d"; https://en.wikipedia.org/wiki/Foo_(bar); [doc](https://example.com/e) http://x.ua/шлях?q=1. ' +
      'Знову https://example.com/a і ftp://no.example.com';
    expect(findUrls(text)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://example.com/e',
      'http://x.ua/шлях?q=1',
    ]);
    expect(findUrls('нічого тут')).toEqual([]);
  });
});
