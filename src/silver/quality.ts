import type { Invoice } from "./parser.js";

export function validateInvoice(invoice: Invoice): Invoice {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!invoice.invoiceNumber) {
    errors.push("Numéro de facture manquant");
  }

  if (
    !invoice.supplier ||
    /^(FACTURE|INVOICE|DEVIS)$/i.test(invoice.supplier.trim())
  ) {
    errors.push("Fournisseur manquant ou invalide");
  }

  if (!invoice.client) {
    errors.push("Client manquant");
  }

  if (!invoice.issueDate) {
    errors.push("Date d'émission absente ou invalide");
  }

  if (!invoice.dueDate) {
    errors.push("Date d'échéance absente ou invalide");
  }

  if (
    invoice.issueDate &&
    invoice.dueDate &&
    invoice.dueDate < invoice.issueDate
  ) {
    errors.push("Date d'échéance antérieure à la date d'émission");
  }

  if (invoice.totalHtCents === null) {
    errors.push("Total HT absent ou invalide");
  }

  if (invoice.totalVatCents === null) {
    errors.push("Total TVA absent ou invalide");
  }

  if (invoice.totalTtcCents === null) {
    errors.push("Total TTC absent ou invalide");
  }

  if (
    invoice.totalHtCents !== null &&
    invoice.totalVatCents !== null &&
    invoice.totalTtcCents !== null
  ) {
    const expected =
      invoice.totalHtCents + invoice.totalVatCents;

    if (Math.abs(expected - invoice.totalTtcCents) > 1) {
      errors.push(
        `Total TTC incohérent : attendu ${expected} centimes, ` +
        `obtenu ${invoice.totalTtcCents}`
      );
    }
  }

  if (invoice.lines.length === 0) {
    errors.push("Aucune ligne de facture reconnue");
  }

  for (const line of invoice.lines) {
    const expected = line.quantity * line.unitPriceCents;

    if (expected !== line.totalHtCents) {
      errors.push(
        `Ligne ${line.lineNumber} : montant HT incohérent`
      );
    }
  }

  if (
    invoice.lines.length > 0 &&
    invoice.totalHtCents !== null
  ) {
    const sum = invoice.lines.reduce(
      (total, line) => total + line.totalHtCents,
      0
    );

    if (Math.abs(sum - invoice.totalHtCents) > 1) {
      errors.push(
        `Somme des lignes incohérente : ${sum} centimes ` +
        `contre ${invoice.totalHtCents}`
      );
    }
  }

  if (
    invoice.lines.length > 0 &&
    invoice.totalVatCents !== null
  ) {
    const expectedVat = invoice.lines.reduce(
      (sum, line) =>
        sum + Math.round(
          line.totalHtCents * line.vatRate / 100
        ),
      0
    );

    if (
      Math.abs(expectedVat - invoice.totalVatCents) >
      invoice.lines.length
    ) {
      errors.push(
        `TVA incohérente : ${expectedVat} centimes attendus`
      );
    }
  }

  if (!invoice.supplierSiret) {
    warnings.push("SIRET fournisseur manquant");
  }

  if (!invoice.clientSiret) {
    warnings.push("SIRET client manquant");
  }

  if (!invoice.status) {
    warnings.push("Statut de paiement manquant");
  }

  invoice.qualityIssues = [...errors, ...warnings];

  invoice.qualityStatus =
    errors.length > 0
      ? "REJECTED"
      : warnings.length > 0
        ? "WARNING"
        : "VALID";

  return invoice;
}
