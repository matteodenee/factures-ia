import "dotenv/config";

import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename
} from "node:fs/promises";

import { join } from "node:path";

import {
  parseInvoice,
  type BronzeDocument,
  type Invoice
} from "./parser.js";

import { validateInvoice } from "./quality.js";

const DATA_DIR = process.env.DATA_DIR || "./data";

const BRONZE_DIR = join(DATA_DIR, "bronze", "documents");
const SILVER_DIR = join(DATA_DIR, "silver");
const QUARANTINE_DIR = join(DATA_DIR, "quarantine");

const PIPELINE_VERSION = "silver-v1";

async function saveJson(
  path: string,
  data: unknown
): Promise<void> {
  const temporary = `${path}.tmp`;

  await writeFile(
    temporary,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  await rename(temporary, path);
}

async function main(): Promise<void> {
  console.log("================================");
  console.log(" CONSTRUCTION SILVER");
  console.log("================================\n");

  await mkdir(SILVER_DIR, { recursive: true });
  await mkdir(QUARANTINE_DIR, { recursive: true });

  const files = (await readdir(BRONZE_DIR))
    .filter(file => file.endsWith(".json"))
    .sort();

  const invoices: Invoice[] = [];
  const rejected: Invoice[] = [];

  const seen = new Set<string>();

  for (const filename of files) {
    try {
      const content = await readFile(
        join(BRONZE_DIR, filename),
        "utf8"
      );

      const bronze = JSON.parse(content) as BronzeDocument;

      if (
        !bronze.documentId ||
        !bronze.extractedText?.trim()
      ) {
        throw new Error("Document Bronze invalide");
      }

      const invoice = validateInvoice(
        parseInvoice(bronze)
      );

      const identifier = [
        invoice.supplier?.toLowerCase(),
        invoice.invoiceNumber?.toLowerCase()
      ].join("|");

      if (
        invoice.supplier &&
        invoice.invoiceNumber &&
        seen.has(identifier)
      ) {
        invoice.qualityIssues.push(
          "Doublon fournisseur / numéro de facture"
        );

        invoice.qualityStatus = "REJECTED";
      }

      if (
        invoice.supplier &&
        invoice.invoiceNumber
      ) {
        seen.add(identifier);
      }

      if (invoice.qualityStatus === "REJECTED") {
        rejected.push(invoice);

        console.log(
          `[REJECTED] ${invoice.filename}`
        );

        for (const issue of invoice.qualityIssues) {
          console.log(`  - ${issue}`);
        }
      } else {
        invoices.push(invoice);

        console.log(
          `[${invoice.qualityStatus}] ${invoice.filename}`
        );
      }

    } catch (error) {
      console.error(
        `[ERROR] ${filename}:`,
        error instanceof Error ? error.message : String(error)
      );

      rejected.push({
        documentId: filename.replace(".json", ""),
        filename,
        invoiceNumber: null,
        supplier: null,
        supplierSiret: null,
        client: null,
        clientSiret: null,
        issueDate: null,
        dueDate: null,
        category: null,
        status: null,
        paymentMethod: null,
        totalHtCents: null,
        totalVatCents: null,
        totalTtcCents: null,
        extractionMethod: "UNKNOWN",
        qualityStatus: "REJECTED",
        qualityIssues: [
          error instanceof Error ? error.message : String(error)
        ],
        lines: []
      });
    }
  }

  const invoiceRows = invoices.map(({ lines, ...invoice }) => invoice);

  const lineRows = invoices.flatMap(invoice =>
    invoice.lines.map(line => ({
      documentId: invoice.documentId,
      invoiceNumber: invoice.invoiceNumber,
      ...line
    }))
  );

  await saveJson(
    join(SILVER_DIR, "invoices.json"),
    invoiceRows
  );

  await saveJson(
    join(SILVER_DIR, "invoice_lines.json"),
    lineRows
  );

  await saveJson(
    join(QUARANTINE_DIR, "rejected.json"),
    rejected
  );

  const report = {
    pipelineVersion: PIPELINE_VERSION,
    totalDocuments: files.length,
    valid: invoices.filter(
      invoice => invoice.qualityStatus === "VALID"
    ).length,
    warnings: invoices.filter(
      invoice => invoice.qualityStatus === "WARNING"
    ).length,
    rejected: rejected.length,
    invoiceLines: lineRows.length,
    issues: rejected.map(invoice => ({
      filename: invoice.filename,
      reasons: invoice.qualityIssues
    }))
  };

  await saveJson(
    join(SILVER_DIR, "quality_report.json"),
    report
  );

  console.log("\n================================");
  console.log(" BILAN SILVER");
  console.log("================================");

  console.log(`Documents analysés : ${report.totalDocuments}`);
  console.log(`Factures valides   : ${report.valid}`);
  console.log(`Avertissements     : ${report.warnings}`);
  console.log(`Rejets             : ${report.rejected}`);
  console.log(`Lignes de facture  : ${report.invoiceLines}`);

  console.log("\nFichiers générés :");
  console.log("data/silver/invoices.json");
  console.log("data/silver/invoice_lines.json");
  console.log("data/silver/quality_report.json");
  console.log("data/quarantine/rejected.json");

  // Des rejets qualité sont des résultats du pipeline,
  // pas nécessairement des erreurs d'exécution.
  if (report.totalDocuments === 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(
    "[FATAL]",
    error instanceof Error ? error.message : String(error)
  );

  process.exitCode = 1;
});
