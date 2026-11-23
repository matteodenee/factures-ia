import test from "node:test";
import assert from "node:assert/strict";

import {
  parseInvoice,
  parseMoney,
  type BronzeDocument
} from "../src/silver/parser.js";

import { validateInvoice } from "../src/silver/quality.js";

function createDocument(header: string): BronzeDocument {
  return {
    documentId: "test-document",
    filename: "test.pdf",
    documentType: "IMAGE",
    pages: [],
    extractedText: `${header}
SIRET : 12345678901234
FACTURE
Numéro de facture : TEST-001
Date d'émission : 01/01/2026
Date d'échéance : 31/01/2026
Client : Client Test
SIRET client : 98765432109876
Formation DuckDB 2 100,00 € 20 % 200,00 €
Total HT 200,00 €
Total TVA 40,00 €
Total TTC 240,00 €
Statut : Payée`
  };
}

test("Conversion monétaire exacte en centimes", () => {
  assert.equal(parseMoney("1 261,21 €"), 126121);
  assert.equal(parseMoney("7 567,26 €"), 756726);
  assert.equal(parseMoney("100,00 €"), 10000);
});

test("Extraction fournisseur PDF natif", () => {
  const invoice = parseInvoice(
    createDocument("Aubry\n96, avenue de Meyer")
  );

  assert.equal(invoice.supplier, "Aubry");
});

test("Extraction fournisseur avec titre en premier", () => {
  const invoice = parseInvoice(
    createDocument("# FACTURE\nAubry\n96, avenue de Meyer")
  );

  assert.equal(invoice.supplier, "Aubry");
});

test("Un titre FACTURE seul n'est pas un fournisseur", () => {
  const invoice = validateInvoice(
    parseInvoice(createDocument("FACTURE"))
  );

  assert.equal(invoice.supplier, null);
  assert.equal(invoice.qualityStatus, "REJECTED");
});

test("Facture cohérente", () => {
  const invoice = validateInvoice(
    parseInvoice(createDocument("Aubry\n96, avenue de Meyer"))
  );

  assert.equal(invoice.qualityStatus, "VALID");
  assert.equal(invoice.totalTtcCents, 24000);
  assert.equal(invoice.lines.length, 1);
});

test("Montant TTC incohérent détecté", () => {
  const document = createDocument("Aubry\n96, avenue de Meyer");

  document.extractedText = document.extractedText.replace(
    "Total TTC 240,00 €",
    "Total TTC 300,00 €"
  );

  const invoice = validateInvoice(parseInvoice(document));

  assert.equal(invoice.qualityStatus, "REJECTED");

  assert.ok(
    invoice.qualityIssues.some(issue =>
      issue.includes("Total TTC incohérent")
    )
  );
});
