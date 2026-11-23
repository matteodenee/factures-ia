import test from "node:test";
import assert from "node:assert/strict";

import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm
} from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test(
  "Une facture avec un TTC incohérent est placée en quarantaine",
  async () => {
    const tempDir = await mkdtemp(
      join(tmpdir(), "factures-ia-test-")
    );

    try {
      const bronzeDir = join(
        tempDir,
        "bronze",
        "documents"
      );

      await mkdir(bronzeDir, { recursive: true });

      const document = {
        documentId: "test-facture-invalide",
        filename: "facture-test-invalide.pdf",
        documentType: "TEXT",
        extractedText: `Aubry
96, avenue de Meyer
SIRET : 77360260298050
FACTURE
Numéro de facture : TEST-2026-001
Date d'émission : 01/01/2026
Date d'échéance : 31/01/2026
Catégorie : Conseil
Statut : En attente
Client : Entreprise Test
SIRET client : 12345678901234
Formation DuckDB 2 100,00 € 20 % 200,00 €
Total HT 200,00 €
Total TVA 40,00 €
Total TTC 300,00 €
Mode de paiement : Virement bancaire`,
        pages: []
      };

      await writeFile(
        join(bronzeDir, "test-facture-invalide.json"),
        JSON.stringify(document, null, 2)
      );

      const execution = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "src/silver/build.ts"
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATA_DIR: tempDir
          },
          encoding: "utf8",
          timeout: 30000
        }
      );

      assert.equal(
        execution.status,
        0,
        execution.stderr || execution.stdout
      );

      const invoices = JSON.parse(
        await readFile(
          join(tempDir, "silver", "invoices.json"),
          "utf8"
        )
      );

      const rejected = JSON.parse(
        await readFile(
          join(tempDir, "quarantine", "rejected.json"),
          "utf8"
        )
      );

      const report = JSON.parse(
        await readFile(
          join(tempDir, "silver", "quality_report.json"),
          "utf8"
        )
      );

      assert.equal(invoices.length, 0);
      assert.equal(rejected.length, 1);

      assert.equal(
        rejected[0].qualityStatus,
        "REJECTED"
      );

      assert.ok(
        rejected[0].qualityIssues.some(
          (issue: string) =>
            issue.includes("Total TTC incohérent")
        )
      );

      assert.equal(report.rejected, 1);
      assert.equal(report.totalDocuments, 1);

      console.log(
        "[OK] Facture incorrecte rejetée"
      );

      console.log(
        "[OK] Motif de rejet enregistré"
      );

      console.log(
        "[OK] Aucune facture invalide dans Silver"
      );

    } finally {
      await rm(tempDir, {
        recursive: true,
        force: true
      });
    }
  }
);
