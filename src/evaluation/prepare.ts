import "dotenv/config";

import {
  readFile,
  writeFile,
  mkdir,
  access
} from "node:fs/promises";

import { join } from "node:path";

interface PDFAnalysis {
  filename: string;
  sha256: string;
  type: "TEXT" | "IMAGE" | "MIXED" | "ERROR";
}

interface GroundTruth {
  filename: string;
  sha256: string;
  invoiceNumber: string | null;
  supplier: string | null;
  client: string | null;
  issueDate: string | null;
  dueDate: string | null;
  status: string | null;
  totalHtCents: number | null;
  totalVatCents: number | null;
  totalTtcCents: number | null;
}

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR || "./data";

  const evaluationDir = join(dataDir, "evaluation");

  await mkdir(evaluationDir, { recursive: true });

  const analysis = JSON.parse(
    await readFile(
      join(dataDir, "analysis", "pdf-analysis.json"),
      "utf8"
    )
  ) as PDFAnalysis[];

  const scanned = analysis
    .filter(pdf => pdf.type === "IMAGE")
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .slice(0, 5);

  if (scanned.length < 5) {
    throw new Error(
      "Il faut au moins cinq factures scannées"
    );
  }

  const outputPath = join(
    evaluationDir,
    "ground-truth.json"
  );

  try {
    await access(outputPath);

    console.log("[SKIP] Vérité terrain déjà présente");
    console.log("Aucune donnée existante n'a été écrasée.");
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const groundTruth: GroundTruth[] = scanned.map(pdf => ({
    filename: pdf.filename,
    sha256: pdf.sha256,
    invoiceNumber: null,
    supplier: null,
    client: null,
    issueDate: null,
    dueDate: null,
    status: null,
    totalHtCents: null,
    totalVatCents: null,
    totalTtcCents: null
  }));

  await writeFile(
    outputPath,
    JSON.stringify(groundTruth, null, 2),
    { encoding: "utf8", flag: "wx" }
  );

  console.log("================================");
  console.log(" PREPARATION EVALUATION OCR");
  console.log("================================\n");

  console.log(`Factures sélectionnées : ${scanned.length}\n`);

  for (const pdf of scanned) {
    console.log(`[PDF] ${pdf.filename}`);
    console.log(`      ${join(dataDir, "raw", pdf.filename)}`);
  }

  console.log(`\n[OK] Fichier créé : ${outputPath}`);
  console.log("[INFO] Les valeurs doivent être vérifiées manuellement.");
}

main().catch(error => {
  console.error(
    "[ERROR]",
    error instanceof Error ? error.message : String(error)
  );

  process.exitCode = 1;
});
