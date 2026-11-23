import "dotenv/config";

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

export interface OCRResult {
  text: string;
  model: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

interface OCRResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export async function recognizeImage(
  imagePath: string
): Promise<OCRResult> {

  const endpoint = process.env.OCR_API_URL;
  const apiKey = process.env.OCR_API_KEY;
  const model =
    process.env.OCR_MODEL || "lightonocr-3-1b-test";

  if (!endpoint || !apiKey) {
    throw new Error(
      "Configuration OCR incomplète dans .env"
    );
  }

  const imageBuffer = await readFile(imagePath);

  const imageBase64 = imageBuffer.toString("base64");

  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${imageBase64}`
            }
          }
        ]
      }
    ],
    temperature: 0.2,
    max_tokens: 4096
  };

  console.log(`[OCR] Modèle : ${model}`);
  console.log(`[OCR] Envoi de l'image...`);

  const start = performance.now();

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000)
  });

  const durationMs = performance.now() - start;

  if (!response.ok) {
    // Ne pas afficher le corps complet d'une réponse
    // serveur : il pourrait contenir des informations sensibles.
    throw new Error(
      `Erreur API OCR : HTTP ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json() as OCRResponse;

  const text = data.choices?.[0]?.message?.content;

  if (typeof text !== "string" || !text.trim()) {
    throw new Error(
      "Le modèle OCR n'a retourné aucun texte exploitable"
    );
  }

  return {
    text,
    model,
    durationMs: Math.round(durationMs),
    inputTokens: data.usage?.prompt_tokens ?? null,
    outputTokens: data.usage?.completion_tokens ?? null
  };
}
