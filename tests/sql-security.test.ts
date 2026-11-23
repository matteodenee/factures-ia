import test from "node:test";
import assert from "node:assert/strict";

import {
  validateReadonlySql
} from "../src/security/sql.js";

test("SELECT simple autorisé", () => {
  assert.doesNotThrow(() =>
    validateReadonlySql(
      "SELECT * FROM silver.invoices"
    )
  );
});

test("Agrégation autorisée", () => {
  assert.doesNotThrow(() =>
    validateReadonlySql(
      "SELECT COUNT(*) FROM silver.invoices"
    )
  );
});

test("DELETE interdit", () => {
  assert.throws(() =>
    validateReadonlySql(
      "DELETE FROM silver.invoices"
    )
  );
});

test("DROP interdit", () => {
  assert.throws(() =>
    validateReadonlySql(
      "DROP TABLE silver.invoices"
    )
  );
});

test("Plusieurs requêtes interdites", () => {
  assert.throws(() =>
    validateReadonlySql(
      "SELECT * FROM silver.invoices; DROP TABLE silver.invoices"
    )
  );
});

test("Accès à une table non autorisée interdit", () => {
  assert.throws(() =>
    validateReadonlySql(
      "SELECT * FROM secret.users"
    )
  );
});

test("Requête vide interdite", () => {
  assert.throws(() =>
    validateReadonlySql("")
  );
});

test("Lecture de fichiers locaux interdite", () => {
  assert.throws(() =>
    validateReadonlySql(
      "SELECT read_text('/etc/passwd') FROM silver.invoices"
    )
  );
});

test("Lecture CSV externe interdite", () => {
  assert.throws(() =>
    validateReadonlySql(
      "SELECT * FROM read_csv('/tmp/test.csv')"
    )
  );
});

test("Requête sans table interdite", () => {
  assert.throws(() =>
    validateReadonlySql(
      "SELECT 1"
    )
  );
});

test("Sous-requête interdite", () => {
  assert.throws(() =>
    validateReadonlySql(
      "SELECT * FROM silver.invoices WHERE total_ttc_cents > (SELECT AVG(total_ttc_cents) FROM silver.invoices)"
    )
  );
});

test("Somme autorisée", () => {
  assert.doesNotThrow(() =>
    validateReadonlySql(
      "SELECT SUM(total_ttc_cents) FROM silver.invoices"
    )
  );
});

test("Filtre par année autorisé", () => {
  assert.doesNotThrow(() =>
    validateReadonlySql(
      "SELECT * FROM silver.invoices WHERE YEAR(issue_date) = 2025"
    )
  );
});

test("CTE interdite", () => {
  assert.throws(() =>
    validateReadonlySql(
      "WITH x AS (SELECT * FROM silver.invoices) SELECT * FROM x"
    )
  );
});

test("UNION interdite", () => {
  assert.throws(() =>
    validateReadonlySql(
      "SELECT invoice_number FROM silver.invoices UNION SELECT invoice_number FROM silver.invoices"
    )
  );
});

test("SELECT INTO interdit", () => {
  assert.throws(() =>
    validateReadonlySql(
      "SELECT * INTO nouvelle_table FROM silver.invoices"
    )
  );
});
