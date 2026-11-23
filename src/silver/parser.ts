import { load } from "cheerio";

export interface InvoiceLine {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  vatRate: number;
  totalHtCents: number;
}

export interface Invoice {
  documentId: string;
  filename: string;
  invoiceNumber: string | null;
  supplier: string | null;
  supplierSiret: string | null;
  client: string | null;
  clientSiret: string | null;
  issueDate: string | null;
  dueDate: string | null;
  category: string | null;
  status: string | null;
  paymentMethod: string | null;
  totalHtCents: number | null;
  totalVatCents: number | null;
  totalTtcCents: number | null;
  extractionMethod: string;
  qualityStatus: "VALID" | "WARNING" | "REJECTED";
  qualityIssues: string[];
  lines: InvoiceLine[];
}

export interface BronzeDocument {
  documentId: string;
  filename: string;
  extractedText: string;
  documentType: string;
  pages: Array<{
    extractionMethod: string;
    text: string;
  }>;
}

function normalize(value: string): string {
  return value
    .replace(/\u00a0|\u202f/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMoney(value: string): number | null {
  const cleaned = normalize(value)
    .replace(/[€\s]/g, "")
    .replace(",", ".");

  if (!/^\d+\.\d{2}$/.test(cleaned)) {
    return null;
  }

  const [euros, cents] = cleaned.split(".");

  const result = Number(euros) * 100 + Number(cents);

  return Number.isSafeInteger(result) ? result : null;
}

function parseDate(value: string | null): string | null {
  if (!value) return null;

  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function field(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const expression = new RegExp(
    `^${escaped}\\s*:\\s*(.+)$`,
    "im"
  );

  const match = text.match(expression);

  return match ? normalize(match[1]) : null;
}

function moneyField(text: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const expression = new RegExp(
    `^${escaped}\\s*[:\\s]+([\\d\\s\\u00a0\\u202f]+,\\d{2})\\s*€`,
    "im"
  );

  const match = text.match(expression);

  return match ? parseMoney(match[1]) : null;
}

function parseInvoiceLine(
  cells: string[],
  lineNumber: number
): InvoiceLine | null {

  if (cells.length !== 5) return null;

  const description = normalize(cells[0]);
  const quantity = Number(normalize(cells[1]));
  const unitPriceCents = parseMoney(cells[2]);
  const vatText = normalize(cells[3]).replace(",", ".");
  const vatRate = Number(vatText.replace("%", "").trim());
  const totalHtCents = parseMoney(cells[4]);

  if (
    !description ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    unitPriceCents === null ||
    !Number.isFinite(vatRate) ||
    vatRate < 0 ||
    vatRate > 100 ||
    totalHtCents === null
  ) {
    return null;
  }

  return {
    lineNumber,
    description,
    quantity,
    unitPriceCents,
    vatRate,
    totalHtCents
  };
}

function extractHtmlLines(text: string): InvoiceLine[] {
  const $ = load(text);
  const lines: InvoiceLine[] = [];

  $("table tr").each((_, row) => {
    const cells = $(row)
      .children("td")
      .map((_, cell) => normalize($(cell).text()))
      .get();

    const parsed = parseInvoiceLine(cells, lines.length + 1);

    if (parsed) {
      lines.push(parsed);
    }
  });

  return lines;
}

function extractTextLines(text: string): InvoiceLine[] {
  const lines: InvoiceLine[] = [];

  const withoutHtml = text.replace(
    /<table\b[^>]*>[\s\S]*?<\/table>/gi,
    ""
  );

  const pattern =
    /^(.+?)\s+(\d+)\s+([\d\s\u00a0\u202f]+,\d{2}\s*€)\s+(\d+(?:[.,]\d+)?\s*%)\s+([\d\s\u00a0\u202f]+,\d{2}\s*€)\s*$/;

  for (const rawLine of withoutHtml.split("\n")) {
    const line = normalize(rawLine);
    const match = line.match(pattern);

    if (!match) continue;

    const parsed = parseInvoiceLine(
      [match[1], match[2], match[3], match[4], match[5]],
      lines.length + 1
    );

    if (parsed) {
      lines.push(parsed);
    }
  }

  return lines;
}



function extractSupplier(lines: string[]): string | null {
  const siretIndex = lines.findIndex(line =>
    /^SIRET\s*:/i.test(line)
  );

  const headerEnd = siretIndex >= 0
    ? siretIndex
    : Math.min(lines.length, 10);

  const header = lines.slice(0, headerEnd);

  const candidates = header.filter(line => {
    const value = line.trim();

    if (!value) return false;

    if (/^(FACTURE|INVOICE|DEVIS)$/i.test(value)) {
      return false;
    }

    if (/^(SIRET|SIREN|TVA|IBAN|BIC)\b/i.test(value)) {
      return false;
    }

    if (/^(Numéro|Date|Client|Catégorie|Statut|Total|Mode de paiement)\s*:/i.test(value)) {
      return false;
    }

    if (/^\d/.test(value)) {
      return false;
    }

    if (/^(rue|avenue|boulevard|chemin|place|impasse)\b/i.test(value)) {
      return false;
    }

    return true;
  });

  return candidates[0] ?? null;
}

export function parseInvoice(document: BronzeDocument): Invoice {
  const text = document.extractedText;

  const withoutTables = text.replace(
    /<table\b[^>]*>[\s\S]*?<\/table>/gi,
    ""
  );

  const cleaned = withoutTables
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\r/g, "");

  const textLines = cleaned
    .split("\n")
    .map(normalize)
    .filter(Boolean);

  const supplier = extractSupplier(textLines);

  const htmlLines = extractHtmlLines(text);
  const nativeLines = extractTextLines(text);

  const lines = [
    ...htmlLines,
    ...nativeLines
  ].map((line, index) => ({
    ...line,
    lineNumber: index + 1
  }));

  const invoice: Invoice = {
    documentId: document.documentId,
    filename: document.filename,
    invoiceNumber: field(cleaned, "Numéro de facture"),
    supplier,
    supplierSiret: field(cleaned, "SIRET"),
    client: field(cleaned, "Client"),
    clientSiret: field(cleaned, "SIRET client"),
    issueDate: parseDate(field(cleaned, "Date d'émission")),
    dueDate: parseDate(field(cleaned, "Date d'échéance")),
    category: field(cleaned, "Catégorie"),
    status: field(cleaned, "Statut"),
    paymentMethod: field(cleaned, "Mode de paiement"),
    totalHtCents:
      moneyField(cleaned, "Total HT") ??
      moneyField(text, "Total HT"),
    totalVatCents:
      moneyField(cleaned, "Total TVA") ??
      moneyField(text, "Total TVA"),
    totalTtcCents:
      moneyField(cleaned, "Total TTC") ??
      moneyField(text, "Total TTC"),
    extractionMethod: document.documentType,
    qualityStatus: "VALID",
    qualityIssues: [],
    lines
  };

  // Les totaux OCR peuvent se trouver dans des tableaux HTML.
  if (
    invoice.totalHtCents === null ||
    invoice.totalVatCents === null ||
    invoice.totalTtcCents === null
  ) {
    const $ = load(text);

    $("table tr").each((_, row) => {
      const cells = $(row)
        .children("td")
        .map((_, cell) => normalize($(cell).text()))
        .get();

      if (cells.length !== 2) return;

      const label = cells[0].toLowerCase();
      const amount = parseMoney(cells[1]);

      if (amount === null) return;

      if (label === "total ht") invoice.totalHtCents = amount;
      if (label === "total tva") invoice.totalVatCents = amount;
      if (label === "total ttc") invoice.totalTtcCents = amount;
    });
  }

  return invoice;
}
